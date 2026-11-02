# Mattermost MCP サーバー runbook

## デプロイ

本番 VM は GCP プロジェクト `my-gcp-project` の `mattermost-vm`（`asia-northeast1-c`）。
`mattermost-infra` は `/opt/mattermost-infra`、このリポジトリは `/opt/mattermost-mcp` に置き、`mcp` コンテナは `mattermost-infra` の Compose が `build: ../../mattermost-mcp` でビルドする。
VM 上のコマンドは root で、特に断りがなければ `/opt/mattermost-infra/compose` で打つ。
標準入力でスクリプトを流し込むと `docker compose exec -T` が残りの行を読み込んでしまうので、1 行ずつ打つ。

```bash
gcloud compute ssh mattermost-vm --zone asia-northeast1-c --project my-gcp-project
sudo -i
cd /opt/mattermost-infra/compose
```

本番の Mattermost と nginx への変更、本番 Mattermost への OAuth アプリの作成は、実行前に利用者の確認を取る。
各手順の結果は「本番投入の記録」に書く。

### 1. 事前確認

```bash
# Mattermost が 11.7.8 であること（OAuth の挙動はこの版で実測している）
grep '^MATTERMOST_IMAGE_TAG=' .env
# OAuth 2.0 サービスプロバイダーが有効であること（true）
jq .ServiceSettings.EnableOAuthServiceProvider /srv/mattermost/config/config.json
# レート制限の設定と、接続元 IP として信頼するヘッダー
jq '{RateLimitSettings, TrustedProxyIPHeader: .ServiceSettings.TrustedProxyIPHeader}' /srv/mattermost/config/config.json
# 下書きの一覧を読むレプリカがないこと（どちらも [] か null）。save_draft は既存の下書きを確かめてから保存するので、遅れたレプリカから読むと本人の書きかけを上書きしうる
jq '.SqlSettings | {DataSourceReplicas, DataSourceSearchReplicas}' /srv/mattermost/config/config.json
# 環境変数でレプリカを足していないこと（何も出ない）。mattermost のイメージには env も sh も無いので、docker inspect で見る
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$(docker compose ps -q mattermost)" | grep -i REPLICA
# 名前が mcp のチームがないこと（0 行）。nginx の ^~ /mcp/ がチームの URL /mcp/... を取ってしまうため。アーカイブ済みも含めて見る
docker compose exec -T postgres psql -U mmuser -d mattermost -tAc "SELECT name, deleteat FROM teams WHERE name = 'mcp'"
# 作業に使うコマンド
command -v git patch openssl
```

- `EnableOAuthServiceProvider` が `false` なら、System Console の Integration Management で「Enable OAuth 2.0 Service Provider」を有効にする（Mattermost の設定変更なので利用者の確認を取る）
- `mcp` という名前のチームがあれば投入しない
- 下書きの同期が有効であることを、作業者のアカウントでログインしたブラウザで `https://mattermost.example.com/api/v4/config/client?format=old` を開いて確かめる。`AllowSyncedDrafts` が `"true"` であること。ログインしていないと項目が出ない。`config.json` ではなくこの API で見るのは、環境変数で上書きされた値も反映されるため
  - `"false"` なら、`save_draft` は「このサーバーでは下書きの同期が無効です。」を返すだけになる。System Console で下書きの同期（`ServiceSettings.AllowSyncedDrafts`）を有効にするか（Mattermost の設定変更なので利用者の確認を取る）、`save_draft` が使えないまま投入するかを利用者と決める
- レプリカが設定されていれば、`save_draft` が既存の下書きを確かめてから保存するまでの窓が、レプリカの遅れの分だけ広がる。その間に本人が画面で書いた下書きは上書きされうる。これを `save_draft` の既知の限界として受け入れるかを利用者と決める
- `RateLimitSettings.Enable` が `false` なら、Mattermost は `mcp` の呼び出しを制限しない
- `Enable` が `true` なら、`mcp` の呼び出しも Mattermost のレート制限の枠を消費する。Mattermost は枠を次の単位で分ける（v11.7.8 の `server/channels/app/ratelimit.go`）
  - `VaryByUser` が `true`: 要求のトークンごと。`mcp` は利用者ごとの OAuth のトークンで呼ぶので、利用者ごとに別の枠になり、その利用者の Web やアプリのセッションとも枠を分け合わない
  - `VaryByUser` が `false` で `VaryByRemoteAddr` が `true`: 接続元 IP ごと。IP は `TrustedProxyIPHeader` に挙げたヘッダー（nginx は `X-Real-IP` と `X-Forwarded-For` を付ける）から取り、空なら接続のアドレスを使う。`mcp` の呼び出しはすべて nginx を通るので、全利用者の MCP の呼び出しが 1 つの枠（ヘッダーを信頼していれば `mcp_net` 上の `mcp` のアドレス、空なら nginx のアドレス）を分け合う。空のときは Web やアプリの利用者も nginx のアドレスで同じ枠に入り、MCP の呼び出しが多いと Web やアプリにも `429` が返る
- 枠を超えると Mattermost は `429` を返し、`mcp` は再試行せずにレート制限のエラーとしてツールの結果に返す。全利用者で 1 つの枠を分け合う設定で、`PerSec` の 60 倍が `mcp` の全体の上限（毎分 600 回）を下回るなら、投入前に Mattermost の設定を変えるか、この影響を受け入れるかを利用者と決める

### 2. OAuth アプリの作成

本番 Mattermost に OAuth 2.0 アプリを 1 つ作る。

| 項目 | 値 |
|---|---|
| 種類 | confidential（`is_public: false`） |
| 信頼済み（`is_trusted`） | はい（MCP サーバーが自分の同意画面を出すため、Mattermost 側の同意を省く） |
| コールバック URL | `https://mattermost.example.com/mcp/oauth/callback` の 1 つだけ |
| 表示名 | `mattermost-mcp` |
| ホームページ | `https://github.com/yui666a/mcp-server-for-mattermost` |

画面で作る場合は、システム管理者で `https://mattermost.example.com/<チーム名>/integrations/oauth2-apps/add` を開く。
「信頼済み」はシステム管理者にだけ表示される。
管理者のトークンで作る場合は次のとおり。

```bash
read -rs MM_ADMIN_TOKEN
curl -s -X POST https://mattermost.example.com/api/v4/oauth/apps \
  -H "Authorization: Bearer $MM_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"mattermost-mcp","description":"Mattermost MCP","homepage":"https://github.com/yui666a/mcp-server-for-mattermost","callback_urls":["https://mattermost.example.com/mcp/oauth/callback"],"is_trusted":true,"is_public":false}' \
  | jq '{id, client_secret, is_trusted, is_public, callback_urls}'
unset MM_ADMIN_TOKEN
```

`id` がクライアント ID、`client_secret` がクライアントシークレット。
シークレットは手順 7 で `.env` に入れるだけにし、記録やチャットに貼らない。

### 3. ソースの配置

`/opt/mattermost-mcp` には、`feat/mcp-server` をマージした後の `main` のコミットを、公開リポジトリから clone して固定する。
新規の配置なので、切り戻し用の直前の版はない。

```bash
git clone https://github.com/yui666a/mcp-server-for-mattermost /opt/mattermost-mcp
git -C /opt/mattermost-mcp checkout --detach <main のコミット ID>
git -C /opt/mattermost-mcp rev-parse HEAD
sha256sum /opt/mattermost-mcp/deploy/mattermost-infra.patch
```

`rev-parse HEAD` と `sha256sum` の出力を「本番投入の記録」に書いてから先へ進む。

### 4. 投入前の退避

`mattermost-infra` にはコミットがなく、前の版を取り出せない。
パッチが書き換えるファイルを、同じディレクトリに `.pre-mcp` の名前でコピーしておく。
切り戻しはこのコピーを基準にする。

```bash
cd /opt/mattermost-infra
cp -p nginx/mattermost.conf nginx/mattermost.conf.pre-mcp
cp -p compose/docker-compose.yml compose/docker-compose.yml.pre-mcp
cp -p compose/env.example compose/env.example.pre-mcp
cp -pn compose/.env compose/.env.pre-mcp
```

- `env.example` は実行には使わないが、戻しておかないと切り戻し後の再投入で手順 5 の照合が一致しなくなる
- `.env` はパッチでは変わらないが、手順 7 で追記する。追記を誤ったときに、Mattermost と Postgres のパスワードを含む元の内容へ戻せるようにする。`-n` を付けるのは、切り戻し後の再投入で、追記済みの `.env` が MCP を入れる前の退避を上書きしないようにするため

### 5. パッチの適用

必ず手順 4 の後に行う。
先に当てると `.pre-mcp` が変更後のコピーになり、切り戻しに使えない。
本番の 3 ファイルが、パッチを作ったときの元（`deploy/mattermost-infra.base/`）と一致することを確かめてから当てる。

```bash
cd /opt/mattermost-mcp/deploy/mattermost-infra.base
sha256sum compose/docker-compose.yml compose/env.example nginx/mattermost.conf > /var/tmp/mcp-base.sha256
cd /opt/mattermost-infra
sha256sum -c /var/tmp/mcp-base.sha256
patch -p1 --dry-run < /opt/mattermost-mcp/deploy/mattermost-infra.patch
patch -p1 < /opt/mattermost-mcp/deploy/mattermost-infra.patch
```

- `sha256sum -c` が 3 つとも `OK` で、`--dry-run` がエラーなく通ったときだけ本番の `patch -p1` を打つ。一致しなければ当てずに、`diff -u /opt/mattermost-mcp/deploy/mattermost-infra.base/<ファイル> <ファイル>` で差分を調べる
- パッチは `tests/nginx-mcp.test.sh` も追加する。開発機で使うテストで、本番では実行しない

### 6. データディレクトリ

`mcp` コンテナは UID 1000（`node`）で動き、`/srv/mcp` を `/data` にマウントする。

```bash
mkdir -p /srv/mcp
chown 1000:1000 /srv/mcp
```

### 7. `compose/.env` への追記

`.env` は root の 600。
シークレットをシェルの履歴に残さないよう、`read` で受けてから書く。
`TOKEN_ENC_KEY` は VM 上で生成し、VM の外に出さない。

```bash
cd /opt/mattermost-infra/compose
# 4 項目のどれかが既にあれば追記しない（切り戻し後の再投入）
grep -E '^(PUBLIC_URL|MM_OAUTH_CLIENT_ID|MM_OAUTH_CLIENT_SECRET|TOKEN_ENC_KEY)=' .env | cut -d= -f1
# 何も出なかったときだけ次の 4 行を打つ。末尾が改行でなければ、追記が最後の行（MMUSER_PASSWORD など）につながるので改行を足す
[ -z "$(tail -c1 .env)" ] || echo >> .env
read -r CID; read -rs CSECRET
printf '%s\n' 'PUBLIC_URL=https://mattermost.example.com' "MM_OAUTH_CLIENT_ID=$CID" "MM_OAUTH_CLIENT_SECRET=$CSECRET" "TOKEN_ENC_KEY=$(openssl rand -base64 32)" >> .env
unset CID CSECRET
# PUBLIC_URL、MM_OAUTH_CLIENT_ID、MM_OAUTH_CLIENT_SECRET、TOKEN_ENC_KEY が 1 回ずつ出る
grep -E '^(PUBLIC_URL|MM_OAUTH_CLIENT_ID|MM_OAUTH_CLIENT_SECRET|TOKEN_ENC_KEY)=.' .env | cut -d= -f1
# .pre-mcp から変わった行の名前（値は出さない）。4 項目だけで、改行を足したときは元の最後の行の名前も出る
diff .env.pre-mcp .env | grep '^>' | cut -d= -f1
```

- 4 項目が既にあるときは追記せず、`TOKEN_ENC_KEY` を作り直さない。`.env` は同じ名前が複数あると後の行が勝つため、追記すると新しい鍵が使われ、`/srv/mcp` に残る Mattermost のトークンを復号できなくなる
- OAuth アプリを作り直したときだけ、`MM_OAUTH_CLIENT_ID` と `MM_OAUTH_CLIENT_SECRET` の行をエディタで書き換える

`docker compose config` の出力はシークレットを平文で含むので、記録に貼らない。

### 8. 設定の確認

nginx を作り直す前に、新しい設定を検査する。

```bash
docker compose run --rm --no-deps nginx nginx -t
```

`syntax is ok` と `test is successful` が出なければ先へ進まない。

### 9. 起動

ビルドと `mcp` の起動は利用者に影響しないので、いつ行ってもよい。

```bash
docker compose build mcp && docker compose up -d mcp
docker compose ps mcp
```

`docker compose ps` が `healthy` になるまで待つ（healthcheck の間隔は既定の 30 秒）。

nginx の作り直しは、10 秒前後 Mattermost に届かなくなるため、日本時間 3 時台に行う。
`nginx -s reload` ではなく作り直すのは、ネットワーク（`mcp_net`）の追加が reload では反映されないため。
また `patch` は `mattermost.conf` を新しいファイルとして書き直すので inode が変わり、動いている nginx のファイル単位の bind mount は古い内容を指したままになる。reload しても新しい設定は読まれない。

```bash
docker compose up -d nginx
```

### 10. `mcp` から Mattermost に届くことの確認

`mcp` は `https://mattermost.example.com` を Compose のネットワーク（`mcp_net`）の中で nginx に解決し、接続元は `mcp_net` 上の `mcp` のアドレスになる。
nginx の `server` は `/srv/nginx/access.conf` を読み込むので、このアドレスが拒否されないことを確かめる。

```bash
cat /srv/nginx/access.conf
docker compose exec mcp getent hosts mattermost.example.com
docker compose exec mcp node -e "fetch('https://mattermost.example.com/api/v4/system/ping').then(r=>console.log(r.status),e=>{console.error(e.cause?.code??e.message);process.exit(1)})"
curl -s https://mattermost.example.com/mcp/healthz
```

- `access.conf` は一般開放の `allow all;`（`nginx/access-open.conf`）であること
- `getent` が返すアドレスは nginx の `mcp_net` 上のアドレス。`ping` は `200`。`403` なら `access.conf` が `mcp` を拒否している
- `/mcp/healthz` は `{"ok":true}`

### 11. 本番での確認

nginx を作り直した後に確かめる。

```bash
curl -s https://mattermost.example.com/.well-known/oauth-protected-resource/mcp | jq .
curl -s https://mattermost.example.com/.well-known/oauth-authorization-server/mcp | jq .
```

- 保護リソースのメタデータは `resource` が `https://mattermost.example.com/mcp`、`authorization_servers` が `["https://mattermost.example.com/mcp"]`、`scopes_supported` が `["mattermost"]`
- 認可サーバーのメタデータは `issuer` が `https://mattermost.example.com/mcp`、各エンドポイントがその下の `/oauth/authorize`、`/oauth/token`、`/oauth/register`、`code_challenge_methods_supported` が `["S256"]`

既存の Mattermost の利用に変化がないことを、作業者のアカウントで確かめる。

- Web でログインし、投稿できる
- 別の端末やブラウザから投稿すると、開いている画面に再読み込みなしで現れる（WebSocket）
- Calls に参加でき、音声が届く

MCP クライアントからつなぐ。作業者のアカウントで、claude.ai のカスタムコネクタ、Claude Code、Codex CLI のそれぞれから `https://mattermost.example.com/mcp` に接続する。

- 読み取り系の 11 ツール（`search_posts`、`read_channel`、`read_thread`、`search_channels`、`search_users`、`get_user`、`get_post`、`list_my_channels`、`get_channel`、`get_unreads`、`get_mentions`）を 1 回ずつ呼び、エラーにならない
  - `get_unreads` は、出力の先頭に CRT の判定の行（`スレッドの折りたたみ（CRT）: 有効（サーバー設定: …）` など）が出る
- `get_file` の画像がクライアントに届くかを、claude.ai、Claude Code、Codex CLI のそれぞれで確かめる。テスト環境では確かめられない（クライアントからつなげる公開の URL が要る）ので、ここで行う
  1. Web で、作業者自身の DM（`@<作業者のユーザー名>`）に、文字の入った画像（スクリーンショットなど）を添付して投稿する
  2. `read_channel` で `@<作業者のユーザー名>` を読み、その投稿に `添付:` の行（`file_id`、名前、種類、大きさ、幅と高さ）が出ることを見る
  3. その `file_id` で `get_file` を呼び、画像に書かれた文字をモデルに読ませる。クライアントの画面に画像が表示されるかどうかと、モデルが中身を答えられたかを分けて記録する
  4. 確かめ終えたら、Web でその投稿を消す
- 書き込み系のツールは、作業者自身の DM（`@<作業者のユーザー名>`）の中だけで確かめる。他のチャンネルや利用者の投稿には触れない
  1. `send_message` で `@<作業者のユーザー名>` に投稿する
  2. その投稿に `add_reaction`（例: `white_check_mark`）を呼び、画面で付いたことを見る。`remove_reaction` で外し、画面で消えたことを見る
  3. `edit_message` でその投稿の本文を変え、画面で変わったことを見る。`delete_message` で消し、画面から消えたことを見る
  4. `save_draft` で `@<作業者のユーザー名>` に下書きを保存し、作業者の DM を開いて入力欄に出ることを見る。送信せず、画面で入力欄を空にして下書きを消す

取り消しと再ログインを確かめる。クライアントは 1 つでよい。

1. Mattermost の「設定 > セキュリティ > OAuth 2.0 アプリ」で `mattermost-mcp` の許可を取り消す
2. 次のツール呼び出しが「Mattermost への再ログインが必要です。コネクタを再接続してください。」を返す
3. その次の要求でクライアントが再ログインを求める
4. 再ログインし、ツールを呼べることを確かめる

ログを確かめる。Cloud Logging で次を検索する。

```text
logName="projects/my-gcp-project/logs/syslog" "tool_call"
```

- 上の呼び出しの `tool_call` が、`mm_user_id`、`tool`、`outcome`、`ms` を持って届いている
- 投稿した本文、検索語、トークン（`Bearer`、`access_token`、`refresh_token`）が含まれていない

### 切り戻し

`.pre-mcp` を基準に戻す。

```bash
cd /opt/mattermost-infra/compose
docker compose rm -sf mcp
cp ../nginx/mattermost.conf.pre-mcp ../nginx/mattermost.conf
cp docker-compose.yml.pre-mcp docker-compose.yml
cp env.example.pre-mcp env.example
rm ../tests/nginx-mcp.test.sh
docker compose up -d nginx
docker network ls --filter name=mcp_net
docker network rm compose_mcp_net
```

- `mcp` のコンテナは `docker-compose.yml` を戻す前に止めて消す。戻した後は Compose のサービスから `mcp` が消え、`docker compose` では扱えなくなる
- nginx は reload ではなく作り直す。ネットワーク（`mcp_net`）の変更は reload では外れない。作り直しの間、10 秒前後 Mattermost に届かなくなる
- ネットワーク名は Compose のプロジェクト名（`compose/` のディレクトリ名 `compose`）と `mcp_net` をつないだもの。`docker network ls` の表示と違えば、表示された名前で消す。nginx を作り直して `mcp_net` から外した後でないと消せない
- ここでは nginx を作り直すので、書き戻しの方法によらず新しい内容が読まれる。それでも `cp` で上書きするのは、`access.conf` のように reload だけで反映させるファイルは同じ inode に書かないとコンテナに見えず、書き戻しの手順をそろえておくため
- `/srv/mcp` と `.env` の 4 項目は残す。`mcp` がなければ使われず、再投入のときに同じ `TOKEN_ENC_KEY` で `/srv/mcp` のデータをそのまま使えるため。再投入では手順 7 の追記をしない

## 環境変数

`mcp` コンテナの環境変数。秘密情報（`MM_OAUTH_CLIENT_SECRET`、`TOKEN_ENC_KEY`）は `mattermost-infra` の `compose/.env` だけに置く。

| 名前 | 本番の値 | 内容 |
|---|---|---|
| `PUBLIC_URL` | `https://mattermost.example.com` | 公開 URL。末尾にスラッシュを付けない。リソースと issuer はこれに `/mcp` を付けたもの |
| `MM_OAUTH_CLIENT_ID` | OAuth アプリの ID | |
| `MM_OAUTH_CLIENT_SECRET` | OAuth アプリのシークレット | |
| `TOKEN_ENC_KEY` | `openssl rand -base64 32` | Mattermost のトークンを暗号化する 32 バイトの鍵 |
| `DB_PATH` | `/data/mcp.sqlite`（Compose で指定） | SQLite ファイル |
| `MM_URL` | 未設定（`PUBLIC_URL` と同じ） | `mcp` から呼ぶ Mattermost の URL |
| `MM_BROWSER_URL` | 未設定（`MM_URL` と同じ） | 利用者のブラウザを送る Mattermost の URL |
| `PORT` | 未設定（3000） | |
| `ACCESS_TOKEN_TTL_SEC` | 未設定（3600） | MCP のアクセストークンの有効期限。ローカルでのリフレッシュの確認にだけ短くする |
| `EXTRA_REDIRECT_URIS` | 未設定 | 追加で許可するリダイレクト URI（カンマ区切りの完全一致） |
| `EXTRA_ALLOWED_ORIGINS` | 未設定 | 追加で許可する `Origin` |

## 運用手順

### nginx を作業者のみに絞っている間

`/srv/nginx/access.conf` を作業者用（`nginx/access-operator.conf.example` を元にしたもの）にしている間は、MCP も使えない。
`mcp` から Mattermost への呼び出しも nginx を通り、`mcp` のアドレスが `deny all;` で拒否されるため。
想定どおりの挙動で、`access-open.conf` に戻せば MCP も戻る。

### 管理コマンド

`mcp` コンテナの中で `node src/admin.ts` を実行する。

```bash
docker compose exec mcp node src/admin.ts list-clients               # 登録された MCP クライアント（client_id、名前、登録時刻、認可済みか）
docker compose exec mcp node src/admin.ts list-clients --unauthorized # 未認可の登録だけ
docker compose exec mcp node src/admin.ts delete-client <client_id>   # 登録を消す。そのクライアントはコネクタの追加し直しが要る
docker compose exec mcp node src/admin.ts purge-credentials          # 認可途中の状態、grant、トークン、重複防止の記録を消す。登録は残す
```

`purge-credentials` を稼働中に実行すると、全利用者が再ログインになる。
通常はスナップショットからの復元でだけ使う。

### 未認可の登録が上限に近いとき

未認可の DCR 登録が 450 件を超えると、`mcp` が `dcr_unauthorized_near_limit`（`count` は件数）を出す。
ログは journald から Cloud Logging の `syslog` ログに届く。

```text
logName="projects/my-gcp-project/logs/syslog" "dcr_unauthorized_near_limit"
```

VM では次のように確かめる。

```bash
docker compose exec mcp node src/admin.ts list-clients --unauthorized | wc -l
docker compose exec mcp node src/admin.ts list-clients --unauthorized | cut -f2,3 | tail -20
docker compose logs --no-log-prefix --since 24h nginx | grep 'POST /mcp/oauth/register' | awk '{print $1}' | sort | uniq -c | sort -rn | head
```

- 正規の利用で未認可の登録が数百件に積み上がることはない（claude.ai でも 1 回の接続で 2 件。「クライアント互換性」）。名前と時刻が揃った登録がまとまっていれば、第三者による積み上げとみなす
- 上限（500 件）に達すると最も古い未認可の登録から消えるので、正規の利用者の新しい接続は妨げられない。消された登録のクライアントはコネクタを追加し直す
- nginx の集計で特定の接続元に偏っていれば、その接続元を記録しておく。登録エンドポイントには IP ごとのレート制限（毎分 60 回）がかかっている

### Mattermost を更新するとき

MCP サーバーは Mattermost 11.7.8 で実測した OAuth の挙動（「Mattermost の OAuth の実測」）を前提にしている。
更新する前に、開発機で新しい版に対して結合テストを通す。

```bash
MATTERMOST_IMAGE_TAG=<新しい版> pnpm dev:up && MATTERMOST_IMAGE_TAG=<新しい版> pnpm test:int
```

通ってから、本番の `/opt/mattermost-infra/compose/.env` の `MATTERMOST_IMAGE_TAG` を更新し、`docker compose up -d mattermost` で作り直す。
通らなければ更新を止め、設計を見直す。

## 障害対応

### `mcp` が再起動を繰り返す

`docker compose ps mcp` が `Restarting` のまま、または `healthy` にならない。
`mcp` が止まっても Mattermost と nginx は動き続け、MCP のパスだけが `502` になる。

```bash
docker compose ps mcp
docker compose logs --tail 50 mcp
```

| ログ | 原因 | 対処 |
|---|---|---|
| `PUBLIC_URL is required` など `... is required` | `.env` の 4 項目が欠けている | 「デプロイ」の手順 7 |
| `TOKEN_ENC_KEY must be 32 bytes in base64` | 鍵の形式の誤り | 鍵を作り直してよいのは、DB に Mattermost のトークンがないときだけ。あるなら元の鍵を探す |
| `unable to open database file` | `/srv/mcp` がない、または UID 1000 が書けない | `ls -ln /srv/mcp`、「デプロイ」の手順 6 |

直したら `docker compose up -d mcp` で作り直す（`.env` の変更は作り直さないと反映されない）。

### スナップショットからの復元

MCP サーバーの SQLite ファイル（`/srv/mcp`）と鍵（`compose/.env`）はブートディスク上にあり、スナップショットスケジュール `mattermost-daily-90d`（日次、日本時間 4 時台、保持 90 日）に含まれる。
古いスナップショットをそのまま起動すると、使用済みのリフレッシュトークンや失効した grant が過去の状態に戻り、古いトークンが再び有効になりうる。
そこで復元したディスクは、起動ディスクにする前に作業用の VM で認証情報を消す。
復元したディスクから直接起動しないのは、Compose のコンテナが `restart: unless-stopped` で自動起動し、同じ VPC の内部（`default-allow-internal`）から巻き戻った MCP サーバーに届くため。

この手順は VM ごとの復元で、Mattermost の DB もスナップショットの時点に戻る。
Mattermost の DB だけを戻すなら、`mattermost-infra` の `scripts/restore-db.sh` を使う。

以下は手元の端末で打つ。

```bash
P='--project my-gcp-project'; Z='--zone asia-northeast1-c'
# 1. スナップショットからディスクを作る
gcloud compute snapshots list $P --filter='sourceDisk~mattermost-vm' --sort-by=~creationTimestamp --limit 5
gcloud compute disks create mattermost-3-restore $P $Z --source-snapshot <スナップショット名> --type pd-balanced
# 2. 作業用の VM を作る（Docker と npm のパッケージを取るため外部 IP は付ける）
gcloud compute instances create mattermost-restore-work $P $Z --machine-type e2-medium \
  --image ubuntu-2604-resolute-amd64-v20261021 --image-project ubuntu-os-cloud
# 3. 起動後に、復元したディスクをデータディスクとして接続する
gcloud compute instances attach-disk mattermost-restore-work $P $Z --disk mattermost-3-restore --device-name restore
gcloud compute ssh mattermost-restore-work $P $Z
```

作業用の VM は、起動してからディスクを接続する。
同じイメージから作ったディスク同士はルートファイルシステムのラベルが同じで、起動時から接続すると復元したディスクから起動しうるため。
イメージが廃止されていれば、`gcloud compute images list --filter='family~ubuntu-2604'` で同じ系列のものを使う。

作業用の VM で打つ。

```bash
sudo -i
curl -fsSL https://get.docker.com | sh
lsblk -o NAME,SIZE,FSTYPE,LABEL /dev/disk/by-id/google-restore
mkdir -p /mnt/restore
mount /dev/disk/by-id/google-restore-part1 /mnt/restore
ls -ln /mnt/restore/srv/mcp
docker build -t mattermost-mcp-restore /mnt/restore/opt/mattermost-mcp
docker run --rm --network none -v /mnt/restore/srv/mcp:/data mattermost-mcp-restore node src/admin.ts list-clients | wc -l
docker run --rm --network none -v /mnt/restore/srv/mcp:/data mattermost-mcp-restore node src/admin.ts purge-credentials
docker run --rm --network none -v /mnt/restore/srv/mcp:/data mattermost-mcp-restore node src/admin.ts list-clients | wc -l
sync
umount /mnt/restore
```

- `/srv/mcp` はディレクトリごとマウントする。SQLite の `-wal`、`-shm` も同じディレクトリにある
- `purge-credentials` は `purged <件数> rows` を出す。前後の `list-clients` の件数が変わらない（DCR の登録は消さない）ことを確かめる
- `--network none` で動かすので、巻き戻った状態の MCP サーバーがどこからも呼ばれない
- 鍵（`TOKEN_ENC_KEY`）は作り直さない。Mattermost のトークンを消すので、古い鍵で暗号化された値は残らない

手元の端末で、ディスクを外して本番 VM の起動ディスクと差し替える。
元の起動ディスクは消さずに残す。

```bash
gcloud compute instances detach-disk mattermost-restore-work $P $Z --disk mattermost-3-restore
gcloud compute instances delete mattermost-restore-work $P $Z
gcloud compute instances describe mattermost-vm $P $Z --format='value(disks[0].source)'
gcloud compute instances stop mattermost-vm $P $Z
gcloud compute instances detach-disk mattermost-vm $P $Z --disk <いまの起動ディスク名>
gcloud compute instances attach-disk mattermost-vm $P $Z --disk mattermost-3-restore --boot
gcloud compute disks add-resource-policies mattermost-3-restore $P $Z --resource-policies mattermost-daily-90d
gcloud compute instances start mattermost-vm $P $Z
```

- 新しい起動ディスクにスナップショットスケジュールを付け直す。付けないと翌日からスナップショットが取られない
- 起動後、各クライアントは手元のリフレッシュトークンが `invalid_grant` で拒否され、通常の再ログインで戻る。スナップショットより後に登録したクライアントは、コネクタを追加し直す

### SQLite ファイルを失った場合

「スナップショットからの復元」と同じ手順で、直近のスナップショットから作ったディスクを作業用の VM に接続し、`purge-credentials` まで行う。
VM の起動ディスクは差し替えず、`/srv/mcp` の中身だけを本番 VM に戻す。

本番 VM で `mcp` を止め、残っているファイルを退避する。

```bash
cd /opt/mattermost-infra/compose
docker compose stop mcp
mkdir /var/tmp/mcp-lost && mv /srv/mcp/* /var/tmp/mcp-lost/
```

手元の端末で、作業用の VM から本番 VM へ流す（手元のディスクには書かない）。

```bash
P='--project my-gcp-project'; Z='--zone asia-northeast1-c'
gcloud compute ssh mattermost-restore-work $P $Z --command 'sudo tar -C /mnt/restore/srv/mcp -cf - .' \
  | gcloud compute ssh mattermost-vm $P $Z --command 'sudo tar -C /srv/mcp -xf -'
```

本番 VM で所有者を揃えて起動する。

```bash
chown -R 1000:1000 /srv/mcp
docker compose up -d mcp
docker compose exec mcp node src/admin.ts list-clients | wc -l
```

作業用の VM では `umount /mnt/restore` し、手元から `detach-disk`、作業用の VM と `mattermost-3-restore` ディスクの削除（`gcloud compute instances delete`、`gcloud compute disks delete`）を行う。
スナップショットより後に登録したクライアントは戻らないので、その利用者にはコネクタを追加し直してもらう。

## 本番投入の記録

「デプロイ」の手順どおりに投入し、結果をここに書く。シークレットと `docker compose config` の出力は書かない。

| 項目 | 結果 |
|---|---|
| 実施日時（JST） | |
| 作業者 | |
| 事前確認: `MATTERMOST_IMAGE_TAG` | |
| 事前確認: `EnableOAuthServiceProvider` | |
| 事前確認: 名前が `mcp` のチーム | |
| 事前確認: `AllowSyncedDrafts`（`/api/v4/config/client?format=old`）、その扱い | |
| 事前確認: `DataSourceReplicas` と `DataSourceSearchReplicas` | |
| 事前確認: `RateLimitSettings` と `TrustedProxyIPHeader`、その扱い | |
| OAuth アプリの作成方法（画面 / 管理者トークン） | |
| OAuth アプリの ID | |
| OAuth アプリの `is_trusted: true`、`is_public: false`、コールバック URL | |
| `/opt/mattermost-mcp` の `git rev-parse HEAD` | |
| `mattermost-infra.patch` の `sha256sum` | |
| `.pre-mcp` の作成（4 ファイル） | |
| `sha256sum -c`（3 ファイル） | |
| `patch -p1 --dry-run` | |
| `patch -p1` | |
| `/srv/mcp` の所有者（`ls -ldn /srv/mcp`） | |
| `.env` の 4 項目（`grep` と `.pre-mcp` との `diff` の結果） | |
| `nginx -t` | |
| `docker compose build mcp` | |
| `docker compose ps mcp` | |
| nginx の作り直しの開始・終了時刻と、Mattermost に届かなかった時間 | |
| `access.conf` の内容 | |
| `mcp` からの名前解決（`getent hosts`） | |
| `mcp` からの `system/ping` | |
| `/mcp/healthz` | |
| 本番での確認: 保護リソースと認可サーバーのメタデータ | |
| 本番での確認: 既存の利用（ログイン、投稿、WebSocket、Calls） | |
| 本番での確認: claude.ai から読み取り系 11 ツール | |
| 本番での確認: Claude Code から読み取り系 11 ツール | |
| 本番での確認: Codex CLI から読み取り系 11 ツール | |
| 本番での確認: claude.ai の `get_file`（画像の表示 / モデルが中身を答えたか） | |
| 本番での確認: Claude Code の `get_file`（画像の表示 / モデルが中身を答えたか） | |
| 本番での確認: Codex CLI の `get_file`（画像の表示 / モデルが中身を答えたか） | |
| 本番での確認: `send_message`（作業者自身の DM） | |
| 本番での確認: `add_reaction` と `remove_reaction`（作業者自身の DM の投稿） | |
| 本番での確認: `edit_message` と `delete_message`（作業者自身の DM の投稿） | |
| 本番での確認: `save_draft`（作業者自身の DM、入力欄に出ること、画面から消したこと） | |
| 本番での確認: 許可の取り消し → 再ログインのエラー → 再ログインの要求 → 再ログイン（使ったクライアント） | |
| 本番での確認: Cloud Logging の `tool_call`（本文・検索語・トークンを含まない） | |

## Mattermost の OAuth の実測

ローカルの Mattermost 11.7.8（`dev/compose.yml`、OAuth アプリは confidential・`is_trusted: true`）に対して `test/int/mattermost-oauth.test.ts` で測った結果。設計の前提のうち、トークンの再利用、リフレッシュ token のローテーション、`pending_post_id` の重複排除は成り立った。リフレッシュによる旧アクセストークンの失効は成り立たなかった（下の「リフレッシュ後の旧アクセストークン」）。

### トークン交換とリフレッシュ

- エンドポイントは `POST {MM_URL}/oauth/access_token`、本文は `application/x-www-form-urlencoded`。
- 認可コード交換の必須パラメータは `grant_type=authorization_code`、`code`、`client_id`、`client_secret`、`redirect_uri`。`redirect_uri` を省かない（省くと 400 `api.oauth.get_access_token.expired_code.app_error`）。認可時と異なる値は 400 `api.oauth.get_access_token.redirect_uri.app_error`。
- リフレッシュの必須パラメータは `grant_type=refresh_token`、`refresh_token`、`client_id`、`client_secret`。`redirect_uri` は不要（付けても 200）。`client_secret` を省く・誤るとどちらも 401 `model.oauth.validate_grant.credentials.app_error`。
- 応答は `access_token`、`refresh_token`、`token_type: bearer`、`expires_in`、`scope`、`id_token`。`expires_in` は 2592000（30 日）で、MCP 側のアクセストークンの期限とは無関係に固定。
- 同じユーザー・同じアプリで再認可すると、期限内なら同じ `access_token` と `refresh_token` が返る（テストで確認）。
- リフレッシュすると新しい `access_token` と `refresh_token` が返り、使用済みの `refresh_token` は二度と使えない。
- 古い `access_token` はリフレッシュ直後も有効なまま残る（8 秒後も `/api/v4/users/me` が 200）。古い `access_token` の失効を `401` の根拠にしない。詳細は下の「リフレッシュ後の旧アクセストークン」。

### 再ログインが要る条件（Task 4 の `refreshTokens` が使う）

エラー応答は `{"id", "message", "detailed_error", "request_id", "status_code"}` の形で、OAuth の `error` 値は `message` の先頭（`invalid_grant: ...`）にだけ現れる。独立した `error` フィールドはない。判定は HTTP ステータスと `id` で行う。

| 状況 | HTTP | `id` | 再ログイン |
|---|---|---|---|
| 使用済みの `refresh_token` | 404 | `api.oauth.get_access_token.refresh_token.app_error` | 要る |
| 存在しない `refresh_token` | 404 | 同上 | 要る |
| 利用者がアプリを取り消した（`POST /oauth/deauthorize`） | 404 | 同上 | 要る |
| 利用者を無効化した（`DELETE /api/v4/users/{id}`） | 404 | 同上 | 要る |
| `refresh_token` 欠落 | 400 | `api.oauth.get_access_token.missing_refresh_token.app_error` | 不要（実装の誤り） |
| `client_secret` の欠落・不一致 | 401 | `model.oauth.validate_grant.credentials.app_error` | 不要（設定の誤り） |

- 再ログインを要求するのは、リフレッシュが 404 かつ `id` が `api.oauth.get_access_token.refresh_token.app_error` のときだけ。
- 無効化の 404 は、無効化で `OAuthAccessData` が消えるため。v11.7.8 のソースには、`OAuthAccessData` が残っていて `DeleteAt != 0` の場合に 403 `api.oauth.get_access_token.expired_code.app_error` を返す分岐もある。ローカルでは到達しなかったが、防御的に 403 の同 `id` も再ログイン扱いにするかは Task 4 で判断する。
- 取り消しは `POST {MM_URL}/oauth/deauthorize`、本文 `{"client_id": "..."}`、利用者の Cookie（`MMAUTHTOKEN`）に加えて `X-Requested-With: XMLHttpRequest` と `X-CSRF-Token`（`MMCSRF` Cookie の値）が必要。Cookie は、ログイン要求に `X-Requested-With: XMLHttpRequest` を付けたときだけ `Set-Cookie` される。

### リフレッシュ後の旧アクセストークン

- 同じユーザー・同じアプリで認可し、リフレッシュしたあと、旧 `access_token` で `GET /api/v4/users/me` を 15 秒間隔で呼んだ。リフレッシュ後 826 秒（約 13.8 分）まで 200 のままで、401 にならなかった。新しい `access_token` も同時に 200。
- Mattermost のセッションキャッシュ（`SessionCacheInMinutes`、既定 10）の 10 分を超えても 200 が続いたため、キャッシュによる一時的な残存ではない。旧 `access_token` に紐づくセッションはリフレッシュで失効せず、セッション自体の期限（`SessionLengthSSOInDays`、既定 30 日、`expires_in` の 2592000 と一致）まで有効とみられる。30 日までは測っていない。
- 旧 `access_token` が 401 になるのが確認できたのは、利用者がアプリを取り消したとき（`POST /oauth/deauthorize`）だけ。
- 設計は「リフレッシュで旧アクセストークンが失効する」と想定していたが、実測では失効しない。クライアントは 401 を受けたら保存済みの資格情報を読み直す方式なので設計は成り立つ。ただしリフレッシュ後の旧トークンは漏えい時のリスクとして残る。

### `pending_post_id` の重複排除

- 同じ `pending_post_id` で `POST /api/v4/posts` を 2 回呼ぶと、2 回目は 201 で最初の投稿と同じ `id` を返す（テストで確認）。

## クライアント互換性

MCP サーバーの前に一時的な HTTPS トンネルを置いて `/mcp` を公開し、3 つのクライアントからつないだ。`ACCESS_TOKEN_TTL_SEC=120` にして `whoami` を 2 分以上空けて 2 回呼び、リフレッシュ後の呼び出しも確かめた。どれも 2 回とも成功した（2026-11-01）。

| クライアント | 登録（DCR）の `redirect_uris` | 認可要求 | コード交換 | リフレッシュ |
|---|---|---|---|---|
| Codex CLI 0.166.0 | `http://127.0.0.1:<port>/callback/<id>` | `resource`、`scope=mattermost`、S256 | `resource` あり | `resource`、`scope` あり |
| Claude Code 2.1.316 | `http://localhost:<port>/callback` | `resource`、`scope=mattermost`、S256 | `resource` あり | `resource` あり、`scope` なし |
| claude.ai | `https://claude.ai/api/mcp/auth_callback` | `resource`、`scope=mattermost`、S256 | `resource` あり | `resource` あり、`scope` なし |

- どのクライアントも、パスを挟んだ形のメタデータ（`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server/mcp`）を見つけ、`token_endpoint_auth_method=none` で登録した。
- claude.ai は 1 回の接続で DCR を 2 回送った。使われない client の登録が残る。
- Codex は、認証なしの要求が 401 になってからリフレッシュする。Claude Code と claude.ai は、期限が近いアクセストークンを使う前にリフレッシュする。
- Claude Code は有効期限が 120 秒だと要求のたびにリフレッシュし、約 1 秒のうちに 5 回続いた。5 回は直列で、どれも 200 だった。同じリフレッシュトークンを並行して送る挙動は観測していない。送られた場合は再利用として grant が取り消され、再ログインになる。
- Claude Code と claude.ai は、認証のあと `server/discover` を送る。サーバーは 400 を返し、クライアントはそのまま次の要求に進んだ。
- claude.ai は、`initialize` を送らずに `tools/call` を送ることがある。サーバーは stateless なので、この要求も処理できる。

## 負荷の確認

ローカルの Mattermost 11.7.8（`dev/compose.yml`）に、本番と同じ上限（`cpus: 0.5`、`mem_limit: 256m`、`pids_limit: 128`、`read_only`）の `mcp` コンテナをつないで測った（2026-11-01、開発機は OrbStack、12 CPU）。`dev/setup.ts` で作る `load1`〜`load6` の 6 人が、それぞれ 4 並列で `read_channel`（`team-a` の `general-dup`、既定の 30 件）を 190 秒呼び続けた。レート制限のエラーが返ったら 250 ms 待って呼び直す。その間、別のセッション（`alice` のログイン）で `GET /api/v4/users/me` を 200 ms おきに呼んで応答時間を測った。

| | 件数 | 中央値 | 95 パーセンタイル | 最大 |
|---|---|---|---|---|
| 負荷なし（120 秒） | 585 | 3.4 ms | 6.4 ms | 13.6 ms |
| 負荷あり（180 秒） | 883 | 2.3 ms | 4.6 ms | 9.1 ms |
| 負荷あり、ツール呼び出しが成功していた秒だけ | 56 | 2.3 ms | 5.1 ms | 7.4 ms |

- 成功したツール呼び出しは 190 秒で 517 回（163 回／分）。`read_channel` 1 回は Mattermost API を約 3.7 回呼ぶので、全体の上限 600 回／分に張り付いていた。残りの 17376 回はレート制限のエラーで、Mattermost には届いていない
- 上限は 60 秒の移動窓なので、Mattermost への呼び出しは窓が空いた瞬間にまとまって出る（成功は 190 秒のうち 10 秒に集中し、最大 94 回／秒）。その秒でも 95 パーセンタイルは負荷なしより低く、悪化は見られなかった。全体の上限 600 回／分は変えない
- `mcp` のメモリは最大 86 MiB（上限 256 MiB の 34 %）、CPU は `docker stats` で最大 56 %（1 CPU を 100 % とする値で、`cpus: 0.5` の上限に張り付いていた）
- 測定は nginx と TLS を通さず（`mcp` から `http://mattermost:8065` へ直接）、12 CPU の開発機で行った。本番は nginx を経由し、VM も e2-medium（2 vCPU）なので、応答時間の絶対値と余裕は本番では小さくなりうる
- `docker stop` で `shutting_down` を出して終了コード 0 で止まった
