# 実測した挙動

設計と実装が前提にしている、Mattermost と MCP クライアントの挙動を測った結果。
Mattermost を更新するときは、結合テスト（`pnpm test:int`）でこれらの前提を確かめ直す（[operations.md の「Mattermost を更新するとき」](operations.md#mattermost-を更新するとき)）。

## Mattermost の OAuth の実測

ローカルの Mattermost 11.7.15（`dev/compose.yml`、OAuth アプリは confidential で `is_trusted: true`）に対して `test/int/mattermost-oauth.test.ts` で測った結果。設計の前提のうち、トークンの再利用、リフレッシュ token のローテーション、`pending_post_id` の重複排除は成り立った。リフレッシュによる旧アクセストークンの失効は成り立たなかった（下の「リフレッシュ後の旧アクセストークン」）。

### トークン交換とリフレッシュ

- エンドポイントは `POST {MM_URL}/oauth/access_token`、本文は `application/x-www-form-urlencoded`。
- 認可コード交換の必須パラメータは `grant_type=authorization_code`、`code`、`client_id`、`client_secret`、`redirect_uri`。`redirect_uri` を省かない。省いたときも認可時と異なる値のときも 400 `api.oauth.get_access_token.redirect_uri.app_error`。使用済みの `code` は 400 `api.oauth.get_access_token.expired_code.app_error`。
- リフレッシュの必須パラメータは `grant_type=refresh_token`、`refresh_token`、`client_id`、`client_secret`。`redirect_uri` は不要（付けても 200）。`client_secret` を省いても誤っても 401 `model.oauth.validate_grant.credentials.app_error`。
- 応答は `access_token`、`refresh_token`、`token_type: bearer`、`expires_in`、`scope`、`id_token`。`expires_in` は 2592000（30 日）で、MCP 側のアクセストークンの期限とは無関係に固定。
- 同じユーザーと同じアプリで再認可すると、期限内なら同じ `access_token` と `refresh_token` が返る（テストで確認）。
- リフレッシュすると新しい `access_token` と `refresh_token` が返り、使用済みの `refresh_token` は二度と使えない。
- 古い `access_token` はリフレッシュ直後も有効なまま残る（8 秒後も `/api/v4/users/me` が 200）。古い `access_token` の失効を `401` の根拠にしない。詳細は下の「リフレッシュ後の旧アクセストークン」。

### 再ログインが要る条件

エラー応答は `{"id", "message", "detailed_error", "request_id", "status_code"}` の形で、OAuth の `error` 値は `message` の先頭（`invalid_grant: ...`）にだけ現れる。独立した `error` フィールドはない。判定は HTTP ステータスと `id` で行う。

| 状況 | HTTP | `id` | 再ログイン |
|---|---|---|---|
| 使用済みの `refresh_token` | 404 | `api.oauth.get_access_token.refresh_token.app_error` | 要る |
| 存在しない `refresh_token` | 404 | 同上 | 要る |
| 利用者がアプリを取り消した（`POST /oauth/deauthorize`） | 404 | 同上 | 要る |
| 利用者を無効化した（`DELETE /api/v4/users/{id}`） | 404 | 同上 | 要る |
| `refresh_token` 欠落 | 400 | `api.oauth.get_access_token.missing_refresh_token.app_error` | 不要（実装の誤り） |
| `client_secret` の欠落か不一致 | 401 | `model.oauth.validate_grant.credentials.app_error` | 不要（設定の誤り） |

- MCP サーバーが再ログインを要求するのは、リフレッシュが 404 かつ `id` が `api.oauth.get_access_token.refresh_token.app_error` のときと、下の 403 のときだけ。
- 無効化の 404 は、無効化で `OAuthAccessData` が消えるため。v11.7.15 のソースには、`OAuthAccessData` が残っていて `DeleteAt != 0` の場合に 403 `api.oauth.get_access_token.expired_code.app_error` を返す分岐もある。ローカルでは到達しなかったが、MCP サーバーはこの 403 も再ログインとして扱う。
- 取り消しは `POST {MM_URL}/oauth/deauthorize`、本文 `{"client_id": "..."}`、利用者の Cookie（`MMAUTHTOKEN`）に加えて、`X-Requested-With: XMLHttpRequest` か `X-CSRF-Token`（`MMCSRF` Cookie の値）のどちらかが必要。どちらも無いとき、`X-CSRF-Token` の値が誤っているときは 401。Cookie は、ログイン要求に `X-Requested-With: XMLHttpRequest` を付けたときだけ `Set-Cookie` される。

### リフレッシュ後の旧アクセストークン

- 同じユーザーと同じアプリで認可し、リフレッシュしたあと、旧 `access_token` で `GET /api/v4/users/me` を 15 秒間隔で呼んだ。リフレッシュ後 841 秒（約 14 分）まで 200 のままで、401 にならなかった。新しい `access_token` も同時に 200。
- Mattermost のセッションキャッシュ（`SessionCacheInMinutes`、既定 10）の 10 分を超えても 200 が続いたため、キャッシュによる一時的な残存ではない。旧 `access_token` に紐づくセッションはリフレッシュで失効せず、セッション自体の期限（`SessionLengthSSOInDays`、既定 30 日、`expires_in` の 2592000 と一致）まで有効とみられる。30 日までは測っていない。
- 旧 `access_token` が 401 になるのが確認できたのは、利用者がアプリを取り消したとき（`POST /oauth/deauthorize`）だけ。
- MCP サーバーは、Mattermost が 401 を返したら保存済みの資格情報を読み直す方式なので、旧トークンが残っても動作は変わらない。Mattermost のトークンは MCP サーバーの外に出さないが、リフレッシュ後の旧トークンは保存先が漏えいしたときのリスクとして残る。

### `pending_post_id` の重複排除

- 同じ `pending_post_id` で `POST /api/v4/posts` を 2 回呼ぶと、2 回目は 201 で最初の投稿と同じ `id` を返す（テストで確認）。

## クライアント互換性

MCP サーバーの前に一時的な HTTPS トンネルを置いて `/mcp` を公開し、3 つのクライアントからつないだ。`ACCESS_TOKEN_TTL_SEC=120` にして、確かめるためだけに置いた一時的なツール（Mattermost の `/api/v4/users/me` を返すもの。いまのツールには無い）を 2 分以上空けて 2 回呼び、リフレッシュ後の呼び出しも確かめた。どれも 2 回とも成功した（2026-11-01）。

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

## 負荷

ローカルの Mattermost 11.7.8（`dev/compose.yml`）に、[deployment.md](deployment.md#4-起動) の `compose.yml` の例と同じ上限（`cpus: 0.5`、`mem_limit: 256m`、`pids_limit: 128`、`read_only`）の `mcp` コンテナをつないで測った（2026-11-01、開発機は Docker、12 CPU）。`dev/setup.ts` で作る `load1`〜`load6` の 6 人が、それぞれ 4 並列で `read_channel`（`team-a` の `general-dup`、既定の 30 件）を 190 秒呼び続けた。レート制限のエラーが返ったら 250 ms 待って呼び直す。その間、別のセッション（`alice` のログイン）で `GET /api/v4/users/me` を 200 ms おきに呼んで応答時間を測った。

| | 件数 | 中央値 | 95 パーセンタイル | 最大 |
|---|---|---|---|---|
| 負荷なし（120 秒） | 585 | 3.4 ms | 6.4 ms | 13.6 ms |
| 負荷あり（180 秒） | 883 | 2.3 ms | 4.6 ms | 9.1 ms |
| 負荷あり、ツール呼び出しが成功していた秒だけ | 56 | 2.3 ms | 5.1 ms | 7.4 ms |

- 成功したツール呼び出しは 190 秒で 517 回（163 回／分）。`read_channel` 1 回は Mattermost API を約 3.7 回呼ぶので、全体の上限 600 回／分に張り付いていた。残りの 17376 回はレート制限のエラーで、Mattermost には届いていない
- 上限は 60 秒の移動窓なので、Mattermost への呼び出しは窓が空いた瞬間にまとまって出る（成功は 190 秒のうち 10 秒に集中し、最大 94 回／秒）。その秒でも 95 パーセンタイルは負荷なしより低く、悪化は見られなかった。全体の上限 600 回／分は変えない
- `mcp` のメモリは最大 86 MiB（上限 256 MiB の 34 %）、CPU は `docker stats` で最大 56 %（1 CPU を 100 % とする値。`cpus: 0.5` は 50 % にあたり、測定値はその付近にあった）
- 測定は nginx と TLS を通さず（`mcp` から `http://mattermost:8065` へ直接）、12 CPU の開発機で行った。リバースプロキシと TLS を経由し、CPU の少ないホストで動かす環境では、応答時間の絶対値と余裕は小さくなりうる
- `docker stop` で `shutting_down` を出して終了コード 0 で止まった
