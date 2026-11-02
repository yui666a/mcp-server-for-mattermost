# 導入手順

MCP サーバーを自分の環境に導入する手順。
MCP サーバーは Docker イメージとして動かし、TLS を終端するリバースプロキシ（例は nginx）の後ろに置く。
動かし方は [operations.md](operations.md)、測った挙動は [measurements.md](measurements.md) にある。

## 配置の形

MCP サーバーは、MCP クライアントに見せる URL（`PUBLIC_URL`）と、Mattermost の URL（`MM_URL`、`MM_BROWSER_URL`）を別々に持つ。
URL はすべて環境変数から組み立て、要求の `Host` や `X-Forwarded-*` は読まない。
そのため次の 2 つの形のどちらでも動く。

| 形 | 例 | MCP のエンドポイント | 設定 |
|---|---|---|---|
| Mattermost と同じオリジン | `https://chat.example.com` の `/mcp` 以下 | `https://chat.example.com/mcp` | `PUBLIC_URL=https://chat.example.com`。`MM_URL` は省略できる |
| 別のホスト | `https://mcp.example.com` | `https://mcp.example.com/mcp` | `PUBLIC_URL=https://mcp.example.com`、`MM_URL=https://chat.example.com` |

- `PUBLIC_URL` はオリジン（スキームとホストとポート）だけにする。パスを含めると、MCP サーバーが返すメタデータの URL と、実際に受け付けるパス（`/mcp`、`/.well-known/...`）が食い違う
- 同じオリジンに置くと、Mattermost のドメイン直下の `/.well-known/oauth-authorization-server` は Mattermost のまま残る。MCP サーバーは issuer を `<PUBLIC_URL>/mcp` にし、パスを挟んだ形（`/.well-known/oauth-authorization-server/mcp`）でメタデータを出すので衝突しない
- 同じオリジンに置くときは、名前が `mcp` のチームを作れない。Mattermost のチームの URL は `/<チーム名>/...` なので、`/mcp/` 以下をリバースプロキシが MCP サーバーへ送ると、そのチームの画面に届かなくなる
- 別のホストに置くと DNS と証明書が 1 つ増えるが、Mattermost のリバースプロキシの設定に手を入れずに済む

PUBLIC_URL は HTTPS にする。
同意画面のクッキーは `__Host-` で始まる名前に `Secure` を付けて発行するため、HTTP ではブラウザが受け取らない。
claude.ai から接続するなら、インターネットから届く必要もある。

## 1. Mattermost の事前確認

OAuth の挙動は Mattermost 11.7.8 で実測している（[measurements.md](measurements.md)）。
ほかの版で動かす前に、その版で結合テストを通す（[operations.md の「Mattermost を更新するとき」](operations.md#mattermost-を更新するとき)）。

| 項目 | 必要な状態 | 満たさないとき |
|---|---|---|
| バージョン | 11.7.8（結合テストを通した版） | 未検証の版では、トークンの再利用やリフレッシュの前提が崩れうる |
| `ServiceSettings.EnableOAuthServiceProvider` | `true`（System Console の Integrations > Integration Management の「Enable OAuth 2.0 Service Provider」） | OAuth アプリを作れず、ログインできない |
| `ServiceSettings.AllowSyncedDrafts` | `true`（既定） | `save_draft` が「このサーバーでは下書きの同期が無効です。」を返すだけになる |
| `FileSettings.EnableFileAttachments` と `MaxFileSize` | `true`、かつ添付の上限（`send_message` の `files` は 128KiB、`prepare_upload` は `UPLOAD_MAX_BYTES`）より大きい | `send_message` の添付と `prepare_upload` の URL へのアップロードが失敗する |
| `SqlSettings.DataSourceReplicas` と `DataSourceSearchReplicas` | 空（環境変数 `MM_SQLSETTINGS_DATASOURCEREPLICAS` などでも足していない） | `save_draft` が既存の下書きを確かめてから保存するまでの窓がレプリカの遅れの分だけ広がり、その間に本人が画面で書いた下書きを上書きしうる |
| 名前が `mcp` のチーム（アーカイブ済みを含む） | 無い（同じオリジンに置くときだけ） | 上の「配置の形」のとおり、そのチームに届かなくなる |
| `RateLimitSettings` と `ServiceSettings.TrustedProxyIPHeader` | 下の説明を読んで判断する | MCP の呼び出しが Mattermost のレート制限の枠を食い合う |

設定の値は、環境変数で上書きされた分も反映される API で確かめるとよい。
システム管理者でログインしたブラウザで `<Mattermost の URL>/api/v4/config/client?format=old` を開くと、`AllowSyncedDrafts`、`EnableFileAttachments`、`MaxFileSize` が見える（ログインしていないと一部の項目が出ない）。
`mcp` チームの有無は、アーカイブ済みも含めて DB で見る。

```sql
SELECT name, deleteat FROM teams WHERE name = 'mcp';
```

Mattermost のレート制限（`RateLimitSettings.Enable` が `true` のとき）は、MCP の呼び出しにもかかる。
枠の分け方は次のとおり（v11.7.8 の `server/channels/app/ratelimit.go`）。

- `VaryByUser` が `true`: トークンごとに枠を分ける。MCP サーバーは利用者ごとの OAuth のトークンで呼ぶので、利用者ごとに別の枠になり、その利用者の Web やアプリのセッションとも分け合わない
- `VaryByUser` が `false` で `VaryByRemoteAddr` が `true`: 接続元 IP ごとに枠を分ける。MCP サーバーからの呼び出しは全利用者ぶんが同じ接続元（MCP サーバー、またはそれが経由するリバースプロキシのアドレス）から来るので、1 つの枠を分け合う。`TrustedProxyIPHeader` が空だと、リバースプロキシの後ろの Web やアプリの利用者も同じ枠に入り、MCP の呼び出しが多いと Web やアプリにも 429 が返る

Mattermost が 429 を返すと、MCP サーバーは再試行せず、レート制限のエラーとしてツールの結果に返す。
全利用者で 1 つの枠を分け合う設定で、`PerSec` の 60 倍が MCP サーバー全体の上限（毎分 600 回）を下回るなら、Mattermost の設定を変えるか、この影響を受け入れるかを決めておく。

## 2. OAuth アプリの作成

Mattermost に OAuth 2.0 アプリを 1 つ作る。

| 項目 | 値 | 理由 |
|---|---|---|
| 種類 | confidential（`is_public: false`） | Mattermost は public client にリフレッシュトークンを出さず、再ログインが頻発する |
| 信頼済み（`is_trusted`） | はい | MCP サーバーが自分の同意画面を出すので、Mattermost 側の同意の二重表示を省く |
| コールバック URL | `<PUBLIC_URL>/mcp/oauth/callback` の 1 つだけ | |
| 表示名 | 任意（例 `mcp-server-for-mattermost`） | 利用者が「設定 > セキュリティ > OAuth 2.0 アプリ」で取り消すときに見る名前 |

画面で作る場合は、システム管理者で `<Mattermost の URL>/<チーム名>/integrations/oauth2-apps/add` を開く。
「信頼済み」はシステム管理者にだけ表示される。
管理者のトークンで作る場合は次のとおり。

```bash
read -rs MM_ADMIN_TOKEN
curl -s -X POST https://chat.example.com/api/v4/oauth/apps \
  -H "Authorization: Bearer $MM_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"mcp-server-for-mattermost","description":"MCP server","homepage":"https://github.com/yui666a/mcp-server-for-mattermost","callback_urls":["https://mcp.example.com/mcp/oauth/callback"],"is_trusted":true,"is_public":false}' \
  | jq '{id, client_secret, is_trusted, is_public, callback_urls}'
unset MM_ADMIN_TOKEN
```

`id` がクライアント ID（`MM_OAUTH_CLIENT_ID`）、`client_secret` がクライアントシークレット（`MM_OAUTH_CLIENT_SECRET`）。

## 3. 環境変数

| 名前 | 必須 | 既定 | 内容 |
|---|---|---|---|
| `PUBLIC_URL` | はい | | MCP クライアントに見せるオリジン。末尾にスラッシュを付けない。リソースと issuer はこれに `/mcp` を付けたもの |
| `MM_OAUTH_CLIENT_ID` | はい | | OAuth アプリの ID |
| `MM_OAUTH_CLIENT_SECRET` | はい | | OAuth アプリのシークレット |
| `TOKEN_ENC_KEY` | はい | | Mattermost のトークンと予約投稿の本文を暗号化する 32 バイトの鍵の base64（`openssl rand -base64 32`） |
| `MM_URL` | | `PUBLIC_URL` | MCP サーバーが API とトークンエンドポイントを呼ぶ Mattermost の URL。末尾にスラッシュを付けない |
| `MM_BROWSER_URL` | | `MM_URL` | 利用者のブラウザを送る Mattermost の URL。パーマリンクもこれで作る |
| `DB_PATH` | | `/data/mcp.sqlite` | SQLite ファイル |
| `PORT` | | `3000` | 待ち受けるポート |
| `ACCESS_TOKEN_TTL_SEC` | | `3600` | MCP のアクセストークンの有効期限（秒）。リフレッシュの確認のときにだけ短くする |
| `EXTRA_REDIRECT_URIS` | | | 追加で登録を許すリダイレクト URI（カンマ区切り、完全一致）。claude.ai、claude.com、ループバックは既定で許可している |
| `EXTRA_ALLOWED_ORIGINS` | | | `/mcp` で追加で許す `Origin`（カンマ区切り）。既定は `https://claude.ai` と `https://claude.com`。`Origin` の無い要求（CLI）は検査しない |
| `UPLOAD_MAX_BYTES` | | `10485760`（10MiB） | `prepare_upload` の URL へ 1 回に送れる要求の本文の上限（バイト）。multipart の枠を含めた本文全体で数える。リバースプロキシの `/mcp/upload/` の本文の上限は、これに 1MiB を足した値にする |

`TOKEN_ENC_KEY` は作り直さない。
変えると保存済みの Mattermost のトークンが読めなくなって全員が再ログインになり、待機中の予約は本文を復号できずに失敗になる。

`MM_URL` は、クライアントシークレットとトークンを送る先なので、証明書を検証できる HTTPS にする。
同じ Docker ホストの中で Mattermost の公開 URL をリバースプロキシに解決させたいときは、Compose でリバースプロキシのサービスに、Mattermost の公開ホスト名をネットワークエイリアスとして付ける。
このエイリアスは MCP サーバーとだけ共有するネットワークに付ける。
Mattermost も入っているネットワークに付けると、Mattermost からも自サイトの名前がプライベート IP に解決され、Mattermost の外向きの通信が予約済みの IP への接続として拒否されうる。

## 4. 起動

イメージはリポジトリ直下の `Dockerfile` からビルドする。
コンテナは UID 1000（`node`）で動き、`/data` に SQLite ファイル（WAL の `-wal`、`-shm` を含む）を書く。

最小の `compose.yml` の例。リバースプロキシは同じホストで動き、`127.0.0.1:3000` へ送る想定。

```yaml
services:
  mcp:
    build: https://github.com/yui666a/mcp-server-for-mattermost.git
    image: mcp-server-for-mattermost
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
    # 送信中の send_message が呼び出しの期限（25 秒）まで走り切れるように、既定の 10 秒より長く待つ
    stop_grace_period: 40s
    environment:
      PUBLIC_URL: https://mcp.example.com
      MM_URL: https://chat.example.com
      MM_OAUTH_CLIENT_ID: ${MM_OAUTH_CLIENT_ID}
      MM_OAUTH_CLIENT_SECRET: ${MM_OAUTH_CLIENT_SECRET}
      TOKEN_ENC_KEY: ${TOKEN_ENC_KEY}
    volumes:
      - ./data:/data
    ports:
      - 127.0.0.1:3000:3000
    cpus: 0.5
    mem_limit: 256m
    pids_limit: 128
    logging:
      driver: local
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/mcp/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
```

```bash
mkdir data && sudo chown 1000:1000 data
# .env に MM_OAUTH_CLIENT_ID、MM_OAUTH_CLIENT_SECRET、TOKEN_ENC_KEY を書き、chmod 600 にする
docker compose up -d --build
docker compose ps    # healthy になるまで待つ（healthcheck の間隔は既定の 30 秒）
```

- リソースの上限は、6 人が全体の上限まで呼び続けた負荷でメモリ最大 86 MiB だった値に余裕を持たせたもの（[measurements.md の「負荷」](measurements.md#負荷)）。`prepare_upload` の URL へのアップロードは、要求の本文とファイルをメモリに置き、全体で同時に 1 件だけ処理する。既定の 10MiB の本文を送ったとき、メモリの使用量は約 80MB 増えた（本文の約 8 倍）。`UPLOAD_MAX_BYTES` を既定より上げるなら、その 8 倍を目安に `mem_limit` も上げる
- MCP サーバーは 1 プロセスで動かす。予約投稿の二重実行の防止と、トークンのリフレッシュの直列化はプロセスの中で行っているため、同じ SQLite ファイルに複数のプロセスを向けない
- `SIGTERM` を受けると新しい接続を断り、処理中の要求が終わってから終了コード 0 で止まる

## 5. リバースプロキシ

MCP サーバーへ送るパスは次の 4 つ。別のホストに置くなら、そのホストのすべてのパスを送ってよい。

| パス | 用途 |
|---|---|
| `/mcp` | MCP の Streamable HTTP（POST だけ） |
| `/mcp/` 以下 | OAuth のエンドポイント（`/mcp/oauth/register`、`authorize`、`consent`、`callback`、`token`）、`/mcp/healthz`、`prepare_upload` のアップロード URL（`/mcp/upload/<トークン>`） |
| `/.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata（RFC 9728） |
| `/.well-known/oauth-authorization-server/mcp` | Authorization Server Metadata（RFC 8414） |

リバースプロキシには次を設定する。

- **要求本文の上限**: 1 MB。MCP サーバー自身も `/mcp` の本文を 1 MiB で断る。添付の上限（128KiB）は、テキストが JSON のエスケープで最大 6 倍に膨らんでも最長の本文と合わせてこの 1 MB に収まるように決めている。`/mcp/upload/` だけは `UPLOAD_MAX_BYTES` に 1MiB を足した値（既定なら 11 MB）に上げる。上げるのはこのパスだけにして、MCP の通常の経路は 1 MB のままにする。MCP サーバーは、上限を 1MiB まで超えた本文は読み切ってから 413 と送り直し方の説明を返し、それより大きい本文は読まずに接続を閉じる。そのため、リバースプロキシの上限が小さいと利用者には説明の無いリバースプロキシの 413 が返り、大きいと送信中に接続が切れて 502 になりうる。また、要求の本文のバッファリング（nginx の `proxy_request_buffering`）は既定の on のままにする。MCP サーバーは、本文の途中で 15 秒データが来ないアップロードを打ち切るが、その間は同時に 1 件だけの処理の枠を取るため、遅い送信元をリバースプロキシで受け止める
- **キャッシュとバッファリングの無効化**: Mattermost 向けの `location /` のキャッシュを MCP のパスに当てない
- **OAuth のエンドポイントへの IP ごとのレート制限**: 登録エンドポイントは認証なしで公開されるので、第三者が登録を積み上げられる。MCP サーバーは接続元 IP を見ないので、制限はリバースプロキシでかける。Express はパスの大文字小文字と末尾のスラッシュを区別しないため、`/mcp/oauth/` 以下を大文字小文字を無視する一致で受けて、変形したパスも枠に入れる。`/mcp` 自体には IP ごとの制限をかけない。claude.ai からの要求は Anthropic の共有の送信元から来るため、全利用者が 1 つの枠を分け合ってしまう（ツールの呼び出しは MCP サーバーの中で利用者ごとに制限している）。同じ理由で、OAuth のエンドポイントの枠も claude.ai の全利用者が 1 つを分け合うので、claude.ai からの接続で 429 が出るなら枠を広げる
- **TLS 1.3 の 0-RTT（Early Data）の無効化**: 0-RTT で送られた要求は再送（リプレイ）されうる。`send_message` の二重投稿や、リフレッシュ要求の再送によるリフレッシュトークン再利用検知の誤発火（その grant のトークンがすべて失効する）を招く。0-RTT が `server` 全体に効く設定なら、Mattermost 本体の POST も同じ危険を抱えるので、全体で無効にしてよい
- MCP サーバーが `MM_URL` 経由で同じリバースプロキシを通って Mattermost を呼ぶなら、MCP サーバーの接続元アドレスがアクセス制限で拒否されないこと

別のホストに置く場合の nginx の例。

```nginx
limit_req_zone $binary_remote_addr zone=mcp_oauth:10m rate=60r/m;

server {
    listen 443 ssl;
    server_name mcp.example.com;
    ssl_certificate     /etc/nginx/certs/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/mcp.example.com/privkey.pem;
    ssl_early_data off;

    location / {
        client_max_body_size 1m;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 120s;
        proxy_pass http://127.0.0.1:3000;

        # proxy_pass は入れ子の location に継承されないため繰り返す
        location ~* ^/mcp/oauth/ {
            limit_req zone=mcp_oauth burst=30 nodelay;
            limit_req_status 429;
            proxy_pass http://127.0.0.1:3000;
        }
        # ~* は、Express がパスの大文字小文字を区別しないため。/MCP/UPLOAD/... も同じ上限で受ける
        location ~* ^/mcp/upload/ {
            client_max_body_size 11m;
            # 最大 5 件を 1 件ずつ Mattermost へ送り、1 件の呼び出しは 25 秒で打ち切る
            proxy_read_timeout 180s;
            proxy_pass http://127.0.0.1:3000;
        }
    }
}
```

Mattermost と同じオリジンに置く場合は、Mattermost の `server` に同じ中身の `location` を 4 つ足し、`ssl_early_data off` にする。

```nginx
location = /mcp { ... }
# ^~ は、/mcp/.../websocket のようなパスが Mattermost の WebSocket 用の正規表現の location に取られないため
location ^~ /mcp/ {
    ...
    location ~* ^/mcp/oauth/ { limit_req zone=mcp_oauth burst=30 nodelay; limit_req_status 429; proxy_pass ...; }
    location ~* ^/mcp/upload/ { client_max_body_size 11m; proxy_read_timeout 180s; proxy_pass ...; }
}
location = /.well-known/oauth-protected-resource/mcp { ... }
location = /.well-known/oauth-authorization-server/mcp { ... }
```

`proxy_pass` に変数（`set $mcp_upstream http://mcp:3000;` と `resolver`）を使うと、nginx は起動時と reload 時に MCP サーバーの名前を解決しない。
MCP サーバーが止まっていても nginx が起動でき、Mattermost は使えるまま MCP のパスだけが 502 になる。

## 6. 動作の確認

```bash
curl -s https://mcp.example.com/mcp/healthz
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp | jq .
curl -s https://mcp.example.com/.well-known/oauth-authorization-server/mcp | jq .
```

- `/mcp/healthz` は `{"ok":true}`
- 保護リソースのメタデータは、`resource` が `<PUBLIC_URL>/mcp`、`authorization_servers` が `["<PUBLIC_URL>/mcp"]`、`scopes_supported` が `["mattermost"]`
- 認可サーバーのメタデータは、`issuer` が `<PUBLIC_URL>/mcp`、各エンドポイントがその下の `/oauth/authorize`、`/oauth/token`、`/oauth/register`、`code_challenge_methods_supported` が `["S256"]`
- 同じオリジンに置いたなら、Mattermost の Web でのログイン、投稿、別の端末からの投稿が再読み込みなしで現れること（WebSocket）も確かめる

続けて MCP クライアントからつなぎ、ツールを一通り呼ぶ（[operations.md の「導入後の確認」](operations.md#導入後の確認)）。
