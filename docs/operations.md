# 運用

導入した MCP サーバーを動かし続けるための手順。
導入は [deployment.md](deployment.md) にある。
コマンドは [deployment.md](deployment.md) の `compose.yml` の例（サービス名 `mcp`）を前提にする。

## 導入後の確認

作業者のアカウントで、使う予定の MCP クライアント（claude.ai、Claude Code、Codex CLI など）から `<PUBLIC_URL>/mcp` に接続する。

- 読み取り系の 17 ツール（`search_posts`、`search_files`、`read_channel`、`read_thread`、`search_channels`、`search_users`、`get_user`、`get_post`、`get_file`、`list_saved_posts`、`list_my_channels`、`get_channel`、`list_channel_members`、`get_unreads`、`get_mentions`、`list_scheduled_messages`、`search_emoji`）を 1 回ずつ呼び、エラーにならない
  - `get_unreads` は、出力の先頭に CRT の判定の行（`スレッドの折りたたみ（CRT）: 有効（サーバー設定: …）` など）が出る
  - `search_files` が「ファイルの検索が無効になっています」を返したら、Mattermost のシステムコンソールでファイル検索が無効にされている。使うなら有効にするよう、Mattermost の管理者に頼む
- `get_file` の画像がクライアントに届くかを、クライアントごとに確かめる。結合テストはクライアントを使わないので、ここでしか確かめられない
  1. Web で、作業者自身の DM（`@<作業者のユーザー名>`）に、文字の入った画像を添付して投稿する
  2. `read_channel` で `@<作業者のユーザー名>` を読み、その投稿に `添付:` の行（`file_id`、名前、種類、大きさ、幅と高さ）が出ることを見る
  3. その `file_id` で `get_file` を呼び、画像に書かれた文字をモデルに読ませる。クライアントの画面に画像が表示されるかと、モデルが中身を答えられたかを分けて見る
  4. 確かめ終えたら、Web でその投稿を消す
- 書き込み系のツールは、作業者自身の DM の中だけで確かめる。他のチャンネルや利用者の投稿には触れない
  1. `send_message` で `@<作業者のユーザー名>` に投稿する
  2. その投稿に `add_reaction`（例 `white_check_mark`）を呼び、画面で付いたことを見る。`remove_reaction` で外し、画面で消えたことを見る。同じ投稿に `save_post` を呼んで画面の保存した投稿に出ること、`pin_post` を呼んで画面のピン留めに出ることを見る。`unsave_post` と `unpin_post` で外し、画面から消えたことを見る
  3. `edit_message` で本文を変え、画面で変わったことを見る。`delete_message` で消し、画面から消えたことを見る
  4. `save_draft` で下書きを保存し、DM を開いて入力欄に出ることを見る。送信せず、画面で入力欄を空にして下書きを消す
  5. `send_message` に `files`（例 `{"name":"check.txt","content_text":"attachment check"}`）を付けて投稿し、画面に添付が出ることを見る。確かめたら `delete_message` で消す
  6. PC でコマンドを実行できるクライアント（Claude Code、Codex CLI など）から、`prepare_upload` で `@<作業者のユーザー名>` の URL を発行し、数 MB の画像を `curl` で送る。返った `file_id` を `send_message` の `file_ids` に渡して投稿し、画面に添付が出ることを見る。同じ URL へもう一度送ると 404 になることも見る。確かめたら `delete_message` で消す
- 予約投稿を、作業者自身の DM の中だけで確かめる。本文は、ほかの手順で送った本文とも互いとも違うものにする（同じ本文だと、やり直しの照合が別の投稿と取り違えうる）
  1. `schedule_message` で、2〜3 分後の時刻に 2 件の予約を入れる
  2. 1 件は `update_scheduled_message` で時刻を 1 分ほど後ろへずらし、もう 1 件は `cancel_scheduled_message` で取り消す
  3. 変えた時刻を過ぎたら（巡回は 30 秒ごとなので 1 分ほど待つ）、`list_scheduled_messages` で、時刻を変えた予約が「投稿済み」になり、パーマリンクがその投稿を開くことを見る。取り消した予約は一覧に出ない
  4. DM の画面に予約の投稿が 1 件だけ出ていることを見る。確かめたら Web でその投稿を消す
- 既読化を、作業者自身の DM の中だけで確かめる
  1. `send_message` で `@<作業者のユーザー名>` に 2 件投稿し、Web で 1 件目を「未読にする」で未読に戻す
  2. `read_channel` に `from: "unread"` を付けて `@<作業者のユーザー名>` を読み、未読に戻した投稿から古い順に出ることを見る
  3. 出た投稿のうち最も新しいものの `post_id` を `last_post_id` にして `mark_as_read` を呼び、画面の未読が消えることを見る。確かめたら `delete_message` で 2 件を消す
- 在席状況とカスタムステータスを、作業者自身のステータスで確かめる。不在（ooo）か取り込み中にしている間は確かめない（不在から変えると Mattermost が自動返信を止め、MCP からは戻せない。取り込み中から取り込み中を設定し直すと、元の終了時刻の後も取り込み中が続く）
  1. 始める前に、`get_user` で自分を読み、`在席:` の行（`（手動で設定）` が付いているか）を控える。カスタムステータスは Web で控える
  2. `set_status` で `dnd` に 10 分ほど後の `dnd_until` を付けて呼び、画面の在席状況が取り込み中になることを見る。`get_user` で自分を読み、`取り込み中（終了: …）` が出ることも見る
  3. `set_custom_status` で絵文字（例 `calendar`）、文言、1 時間後の `until` を指定し、画面のカスタムステータスに出ることを見る。`clear_custom_status` で消し、画面から消えたことを見る
  4. `set_status` で控えた在席状況に戻す（`（手動で設定）` が付いていなかったなら `online`）。カスタムステータスがあったなら、Web で設定し直す。Web のカスタムステータスの「最近使った」一覧から、確かめに使ったものを消す
- 取り消しと再ログイン
  1. Mattermost の「設定 > セキュリティ > OAuth 2.0 アプリ」で、作った OAuth アプリの許可を取り消す
  2. 次のツール呼び出しが「Mattermost への再ログインが必要です。コネクタを再接続してください。」を返す
  3. その次の要求でクライアントが再ログインを求め、再ログインするとツールを呼べる
- ログ（下の「ログ」）に、上の呼び出しの `tool_call`、予約の `scheduled_post`、アップロードの `upload` が出ていて、投稿の本文、検索語、トークン（`Bearer`、`access_token`、`refresh_token`、アップロード URL のトークン）、添付のファイル名と中身が含まれていない

## ログ

1 行 1 件の JSON を標準出力に出す。
各行は `ts`（時刻）と `event` を持つ。
投稿の本文、検索語、トークンは出さない。

```bash
docker compose logs --no-log-prefix mcp | grep '"event":"tool_call"'
```

| `event` | 内容 |
|---|---|
| `tool_call` | ツールの呼び出し。`mm_user_id`、`tool`、`outcome`（`ok`、`tool_error`、`input_error`、`reauthorize`、`rate_limited`、`upstream_unavailable`、`mm_error`、`error`）、`ms` |
| `scheduled_post` | 予約の投稿の結果。`mm_user_id`、`outcome` |
| `upload` | `prepare_upload` の URL へのアップロード。`mm_user_id`、`outcome`（`ok`、`too_large`、`client_gone`（本文の途中で接続が切れた）、`stalled`（本文を待つ間に 15 秒データが来なかった）、`InputError`、`MmError`、`RateLimited`、`UpstreamUnavailable` など）、`files`（Mattermost へ送れた件数）、`bytes`（受け取ったファイルの合計）、`ms`。URL が無効なときと、同時に処理できる件数を超えたときは出ない |
| `token_issued`、`token_refreshed` | MCP のトークンの発行とリフレッシュ。`client_id`、`mm_user_id` |
| `token_reuse_detected` | 使用済みの認可コードかリフレッシュトークンが再び提示され、その grant を失効させた。`client_id`。そのクライアントは再ログインになる。同じクライアントで繰り返すなら、トークンの漏えいか、クライアントが同じリフレッシュトークンを並行して送っていることを疑う |
| `mm_refresh_config_error` | Mattermost が、再ログインで直るもの以外の 4xx でリフレッシュを断った。`status`、`id`。`model.oauth.validate_grant.credentials.app_error`（401）なら `MM_OAUTH_CLIENT_SECRET` が OAuth アプリと合っていない（シークレットを作り直した場合など）。ツールは一時的なエラーを返し続ける |
| `dcr_registered`、`dcr_unauthorized_near_limit` | クライアントの登録と、未認可の登録が上限に近いことの警告（下の「未認可の登録が上限に近いとき」） |
| `authorize_completed`、`authorize_upstream_failed` | 利用者のログインの完了と、Mattermost との通信の失敗（`step` が `exchange` か `users_me`） |
| `unhandled_error`、`tool_unhandled_error`、`upload_unhandled_error`、`scheduled_post_error`、`scheduler_failed`、`sweep_failed` | 想定外の失敗。エラーの名前とコードだけを持つ |
| `listening`、`shutting_down` | 起動と停止 |

## 管理コマンド

コンテナの中で `node src/admin.ts` を実行する。
`TOKEN_ENC_KEY` は要らず、`DB_PATH`（既定 `/data/mcp.sqlite`）の DB を直接操作する。

```bash
docker compose exec mcp node src/admin.ts list-clients               # 登録された MCP クライアント（client_id、名前、登録時刻、認可済みか）
docker compose exec mcp node src/admin.ts list-clients --unauthorized # 未認可の登録だけ
docker compose exec mcp node src/admin.ts delete-client <client_id>   # 登録を消す。そのクライアントはコネクタの追加し直しが要る
docker compose exec mcp node src/admin.ts purge-credentials          # 認可途中の状態、grant、トークン、アップロード URL、重複防止の記録を消す。登録は残す
docker compose exec mcp node src/admin.ts invalidate-scheduled       # 待機中と投稿中の予約をすべて失敗にする。投稿済みと失敗の予約は残す
```

`purge-credentials` を稼働中に実行すると、全利用者が再ログインになる。
通常はバックアップからの復元でだけ使い、そのときは `invalidate-scheduled` も続けて実行する（下の「バックアップと復元」）。

## 未認可の登録が上限に近いとき

未認可の登録（DCR で登録されたが、まだ一度も利用者が認可を完了していないもの）は 7 日で消え、500 件を上限に古いものから消える。
450 件を超えると `dcr_unauthorized_near_limit`（`count` は件数）が出る。

```bash
docker compose exec mcp node src/admin.ts list-clients --unauthorized | wc -l
docker compose exec mcp node src/admin.ts list-clients --unauthorized | cut -f2,3 | tail -20
```

- 正規の利用で未認可の登録が数百件に積み上がることはない（claude.ai でも 1 回の接続で 2 件。[measurements.md の「クライアント互換性」](measurements.md#クライアント互換性)）。名前と時刻が揃った登録がまとまっていれば、第三者による積み上げとみなす
- 上限に達すると最も古い未認可の登録から消えるので、正規の利用者の新しい接続は妨げられない。認可済みの登録は自動では消えない
- リバースプロキシのアクセスログで `POST /mcp/oauth/register` の接続元を集計し、偏りがあれば記録しておく。登録エンドポイントには IP ごとのレート制限をかけておく（[deployment.md の「リバースプロキシ」](deployment.md#5-リバースプロキシ)）

## Mattermost を更新するとき

MCP サーバーは Mattermost 11.7.8 で実測した OAuth の挙動（[measurements.md](measurements.md)）と、公開文書にない `pending_post_id` の重複排除を前提にしている。
更新する前に、開発機で新しい版に対して結合テストを通す。

```bash
pnpm dev:down
MATTERMOST_IMAGE_TAG=<新しい版> pnpm dev:up
pnpm test:int
```

通ってから運用中の Mattermost を更新する。
通らなければ更新を止め、食い違った挙動を調べる。

## MCP サーバーを更新するとき

更新の前に、下の「バックアップと復元」のとおりに `/data` を写しておく。
新しい版をビルドしてコンテナを作り直す（`docker compose up -d --build mcp`）。

DB のスキーマは、起動のたびに `CREATE TABLE IF NOT EXISTS` で作り、そのあと `src/db.ts` の `migrate` に書いた列を、既存の表に無ければ足す。
`migrate` が扱うのは、列の追加だけである。新しい版で表が増えれば `CREATE TABLE` で足されるが、既存の列の変更や削除は既存の DB に反映されない。
更新の前に `src/db.ts` の差分を見て、`migrate` で足す列のほかに既存の表が変わっていれば、移行の手順が示されていない限りその版へは更新しない。
戻すときは、前の版のイメージと、更新前に写した `/data` を一緒に戻す。

## バックアップと復元

MCP サーバーの状態は、`/data` の SQLite ファイル（`mcp.sqlite`、`-wal`、`-shm`）と `TOKEN_ENC_KEY` だけにある。
バックアップは、コンテナを止めてディレクトリごと写すか、ディレクトリを含むディスクのスナップショットで取る。
鍵は SQLite ファイルとは別に保管する。

古いバックアップをそのまま起動すると、使用済みのリフレッシュトークンや失効した grant が過去の状態に戻り、ローテーション済みの古いトークンが再び有効になりうる。
また、その後に取り消したり変えたりした予約が待機中のまま戻り、投稿されてしまう。
そこで、復元した SQLite ファイルは、MCP サーバーとして起動する前に、ネットワークなしのコンテナで認証情報を消し、予約を失敗にする。

```bash
docker compose stop mcp
# 復元したファイルを ./data に置き、所有者を UID 1000 にそろえる
sudo chown -R 1000:1000 data
docker run --rm --network none -v "$PWD/data:/data" mcp-server-for-mattermost node src/admin.ts list-clients | wc -l
docker run --rm --network none -v "$PWD/data:/data" mcp-server-for-mattermost node src/admin.ts purge-credentials
docker run --rm --network none -v "$PWD/data:/data" mcp-server-for-mattermost node src/admin.ts invalidate-scheduled
docker run --rm --network none -v "$PWD/data:/data" mcp-server-for-mattermost node src/admin.ts list-clients | wc -l
docker compose up -d mcp
```

- `purge-credentials` は `purged <件数> rows` を出す。前後の `list-clients` の件数が変わらない（DCR の登録は消さない）ことを確かめる。登録が残るので、各クライアントは手元のリフレッシュトークンが `invalid_grant` で拒否された後、通常の再ログインで戻る
- `invalidate-scheduled` は `invalidated <件数> scheduled posts` を出す。失敗にした予約は `list_scheduled_messages` に理由とともに出るので、件数が 0 でなければ利用者に予約を確かめて入れ直すよう知らせる。投稿を試みた予約と、予定時刻を過ぎた予約は、理由が「投稿されたか不明」になる（バックアップの後に投稿されていたかもしれないため）
- 管理コマンドは `docker compose exec` ではなく、MCP サーバーを起動しない単独のコンテナで、ネットワークなしで動かす。イメージ名は [deployment.md](deployment.md#4-起動) の `compose.yml` の例で付けたもの
- 鍵（`TOKEN_ENC_KEY`）は作り直さない。失敗にした予約の本文は同じ鍵で暗号化されたまま更新から 7 日残り、作り直すと `list_scheduled_messages` で本文が読めなくなる
- バックアップより後に登録したクライアントは戻らないので、その利用者にはコネクタを追加し直してもらう
- 復元したディスクごと起動する方式（VM のスナップショットからの起動など）では、MCP サーバーのコンテナが自動起動する前に上の処理を済ませる。巻き戻った状態の MCP サーバーに、どこからも届かないようにするため

SQLite ファイルを失い、バックアップも無いときは、空の `/data` で起動し直す。
登録、ログイン、予約はすべて失われ、利用者はコネクタを追加し直す。
予約していた利用者には、予約が失われたことを知らせる。

## 障害対応

### `mcp` が再起動を繰り返す

`docker compose ps mcp` が `Restarting` のまま、または `healthy` にならない。
MCP サーバーが止まっても Mattermost は動き続け、MCP のパスだけが 502 になる。

```bash
docker compose ps mcp
docker compose logs --tail 50 mcp
```

| ログ | 原因 | 対処 |
|---|---|---|
| `PUBLIC_URL is required` など `... is required` | 必須の環境変数が欠けている | [deployment.md の「環境変数」](deployment.md#3-環境変数) |
| `PUBLIC_URL must not end with a slash` | `PUBLIC_URL` の末尾のスラッシュ | 外す |
| `TOKEN_ENC_KEY must be 32 bytes in base64` | 鍵の形式の誤り | 鍵を作り直してよいのは、DB に Mattermost のトークンも待機中の予約も無いときだけ。あるなら元の鍵を探す |
| `... must be a positive integer` | `PORT` か `ACCESS_TOKEN_TTL_SEC` の値 | 正の整数にする |
| `unable to open database file` | `/data` が無い、または UID 1000 が書けない | `ls -ln data`、`chown 1000:1000 data` |

直したら `docker compose up -d mcp` で作り直す（環境変数の変更は作り直さないと反映されない）。

### ツールが「Mattermost に一時的に接続できません」を返す

MCP サーバーから `MM_URL` に届いていない。

```bash
docker compose exec mcp node -e "fetch(process.env.MM_URL+'/api/v4/system/ping').then(r=>console.log(r.status),e=>{console.error(e.cause?.code??e.message);process.exit(1)})"
```

`MM_URL` を省略して `PUBLIC_URL` と同じにしているときは、`PUBLIC_URL` に置き換えて打つ。
200 以外なら、名前解決、証明書、リバースプロキシのアクセス制限（MCP サーバーの接続元アドレスが拒否されていないか）を確かめる。
リバースプロキシで一時的にアクセスを作業者だけに絞っている間は、MCP サーバーから Mattermost への呼び出しも同じ制限を受けるので、MCP も使えなくなる。
