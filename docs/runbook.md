# Mattermost MCP サーバー runbook

## デプロイ

## 環境変数

## 運用手順

## 障害対応

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

ローカルの Mattermost の前に一時的な HTTPS トンネルを置き、`/mcp` を公開して 3 つのクライアントからつないだ。`ACCESS_TOKEN_TTL_SEC=120` にして、`whoami` を 2 分以上空けて 2 回呼び、リフレッシュも確かめた。どれも 2 回とも成功した（2026-11-01）。

| クライアント | 登録（DCR）の `redirect_uris` | 認可要求 | コード交換 | リフレッシュ |
|---|---|---|---|---|
| Codex CLI 0.166.0 | `http://127.0.0.1:<port>/callback/<id>` | `resource`、`scope=mattermost`、S256 | `resource` あり | `resource`、`scope` あり |
| Claude Code 2.1.316 | `http://localhost:<port>/callback` | `resource`、`scope=mattermost`、S256 | `resource` あり | `resource` あり、`scope` なし |
| claude.ai | `https://claude.ai/api/mcp/auth_callback` | `resource`、`scope=mattermost`、S256 | `resource` あり | `resource` あり、`scope` なし |

- どのクライアントも、パスを挟んだ形のメタデータ（`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server/mcp`）を見つけ、`token_endpoint_auth_method=none` で登録した。
- Claude Code と claude.ai は、`initialize` の前に `server/discover` を送る。サーバーはこれを 400 で返し、クライアントはそのまま `initialize` に進む。
- Claude Code は、期限が近いアクセストークンを使う前にリフレッシュする。有効期限が 120 秒だと要求のたびにリフレッシュし、1 秒のうちに 5 回続いた。どれも直前に受け取ったリフレッシュトークンを使うので、再利用の検知には当たらない。本番の 3600 秒では起きない。
- claude.ai は、要求のたびに `initialize` を送るとは限らない。stateless なので問題ない。
