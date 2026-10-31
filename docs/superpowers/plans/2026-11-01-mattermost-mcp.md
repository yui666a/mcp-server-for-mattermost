# Mattermost リモート MCP サーバー 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `https://mattermost.example.com/mcp` で、claude.ai、Claude Code、Codex CLI から Mattermost アカウントでログインして使える MCP サーバーを、既存の Compose に追加する。

**Architecture:** このリポジトリ（`mattermost-mcp`）に TypeScript の単一プロセスの HTTP サーバーを置く。MCP クライアント向けの OAuth 認可サーバー（メタデータ、DCR、同意画面、トークン）を自前で実装し、ログインは Mattermost の OAuth（confidential client）に委ねる。MCP の転送は `@modelcontextprotocol/sdk` の Streamable HTTP（stateless）を使い、状態は SQLite（`node:sqlite`）に置く。nginx は MCP のパスだけを新しい `mcp` コンテナへ振り分ける。

**Tech Stack:** Node.js 26（LTS、TypeScript を型除去でそのまま実行）、`@modelcontextprotocol/sdk` 1.32.2、`express` 5、`zod` 4、`node:sqlite`、`vitest` 5、Docker Compose、nginx 1.28、Mattermost Team Edition 11.7.8（ローカルの結合テスト用）

**Spec:** `docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md`

## Global Constraints

- 公開 URL `https://mattermost.example.com`。リソースと issuer は `https://mattermost.example.com/mcp`（末尾スラッシュなし）
- メタデータ: `/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server/mcp`
- OAuth エンドポイント: `/mcp/oauth/register`、`/mcp/oauth/authorize`（GET）、`/mcp/oauth/consent`（POST）、`/mcp/oauth/callback`、`/mcp/oauth/token`。ヘルスチェック `/mcp/healthz`
- スコープは `mattermost` の 1 つ。PKCE は `S256` のみ。DCR のクライアントは public client（`token_endpoint_auth_method: none`）
- `resource` は認可要求とトークン要求で必須・完全一致。欠落・不一致は `invalid_target`
- 許可するリダイレクト URI: `https://claude.ai/api/mcp/auth_callback`、`https://claude.com/api/mcp/auth_callback`、`http://localhost:<port>/<path>`、`http://127.0.0.1:<port>/<path>`、環境変数 `EXTRA_REDIRECT_URIS`（カンマ区切りの完全一致 URI）
- 許可する `Origin`: `https://claude.ai`、`https://claude.com`、環境変数 `EXTRA_ALLOWED_ORIGINS`
- 有効期限: MCP アクセストークン 3600 秒、リフレッシュトークンは最終利用から 90 日（ローテーションで延長、絶対期限なし）、認可途中の記録 600 秒、MCP の認可コード 60 秒、未認可の DCR 登録 7 日（上限 500 件、超えたら最古から削除）、`send_message` の重複判定 600 秒
- Mattermost API: タイムアウト 20 秒、「投稿中」を結果不明とみなす猶予 30 秒、同時実行はユーザーあたり 4・全体 16、レート制限は API 呼び出し数でユーザーあたり 120 回／分・全体 600 回／分
- 件数の既定と上限: `read_channel` 30／100、`read_thread` 50／200、`search_posts` 20／50、`search_channels` と `search_users` 20／50。本文は 1 件あたり 4000 文字で切る
- DCR の入力上限: `client_name` 100 文字、`redirect_uris` 5 件、URI 1 件 2000 文字。制御文字（U+0000–U+001F、U+007F–U+009F）を含めば拒否
- Cookie 名 `__Host-mcp_authz_<session_id>`、値は `<cookie_secret>`（`Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`、`Domain` なし）。`session_id` は認可途中の記録の公開 ID（16 文字のランダム値）、`cookie_secret` は別のランダム値で、サーバーにはそのハッシュだけを置く。同じブラウザで 2 つの認可を並行して進めても互いに上書きしないよう、Cookie 名を記録ごとに変える。同意の POST はフォームの hidden に入れた `session_id` から、コールバックは上流の `state` から記録を引き、その名前の Cookie の値を照合する
- MCP アクセストークンの有効期限は環境変数 `ACCESS_TOKEN_TTL_SEC`（既定 3600）で変えられる。ローカルでのリフレッシュ確認にだけ短くする
- 同意画面とエラーページの応答ヘッダー: `Content-Security-Policy: default-src 'none'; style-src 'self'; base-uri 'none'; form-action <下記>; frame-ancestors 'none'`、`X-Frame-Options: DENY`。スクリプトは使わない。Chrome と Safari は `form-action` をフォーム送信後のリダイレクト先にも適用するため、同意画面の `form-action` は `'self'`、`MM_BROWSER_URL` のオリジン、その要求の `redirect_uri` のオリジン（ループバックは `http://localhost:*` または `http://127.0.0.1:*`）を並べる。エラーページは `form-action 'none'`
- `mcp` コンテナ: `cpus: 0.5`、`mem_limit: 256m`、`pids_limit: 128`、`logging.driver: journald`、ホストにポートを公開しない
- ログに本文、検索語、トークン、Cookie を出さない
- 秘密情報（`MM_OAUTH_CLIENT_SECRET`、`TOKEN_ENC_KEY`）は `mattermost-infra` の `compose/.env` だけに置き、リポジトリに入れない
- 本番の Mattermost と nginx への変更、本番 Mattermost への OAuth アプリ作成は、実行前に利用者の確認を取る
- リポジトリは `mattermost-mcp`（既定ブランチ `main`）。作業は `main` から切ったブランチ `feat/mcp-server` で行い、Task ごとにコミットする。コミットメッセージは `feat: ` などの conventional commits の接頭辞に日本語の要約。push と PR 作成は利用者の指示があったときだけ行う
- Compose と nginx は隣のリポジトリ `mattermost-infra`（`../mattermost-infra`、本番 VM では `/opt/mattermost-infra`）にある。本番 VM ではこのリポジトリを `/opt/mattermost-mcp` に置く。`mattermost-infra` へのコミットは利用者の指示があったときだけ行う
- 各 Task の完了時に、別の Claude（または Codex）のレビューで承認を得てから次の Task に進む。critical / high / middle / must / imo / ask の指摘は修正して再レビューを受ける

## Review Focus

- 同じ利用者が 2 つのクライアント（例: claude.ai と Claude Code）から使っているとき、片方の要求で Mattermost のトークンがリフレッシュされても、もう片方は再ログインなしで動き続ける → Task 6 のテスト `shared credential survives refresh by another grant`
- Mattermost が落ちている、または `5xx` を返すとき、ツールは一時的なエラーを返し、MCP の grant も Mattermost のトークンも失効しない → Task 6 のテスト `transient upstream failure keeps grants`
- 利用者が Mattermost でアプリの許可を取り消した、または無効化されたとき、次の呼び出しで `401` になり、再ログインすれば戻る → Task 6 のテスト `revoked app forces relogin`
- 同名のチャンネルが 2 つのチームにあるとき、名前だけで `send_message` すると投稿せずに候補を返す → Task 9 のテスト `ambiguous channel name is rejected for send_message`
- 絵文字や結合文字を含む長い本文を 4000 文字で切っても、文字（書記素クラスタ）を途中で切らず、切ったことが出力に出る → Task 8 のテスト `truncation keeps grapheme clusters`
- クライアントがリフレッシュ要求で `resource` を送らないと、1 時間ごとに再ログインになる → Task 7 Step 4 で 3 クライアントのリフレッシュを確かめる

---

## ファイル構成

| パス | 責務 |
|---|---|
| `package.json`、`package-lock.json`、`tsconfig.json` | 依存（`@modelcontextprotocol/sdk@1.32.2`、`express@5`、`zod@4`、dev に `vitest@5`、`typescript@5`、`supertest`、`@types/express`、`@types/node`）はすべて完全なバージョンで固定し、`package-lock.json` も成果物に含める。スクリプト `start`（`node src/main.ts`）、`test`、`test:int`、`typecheck`（`tsc --noEmit`）。`tsconfig` は `strict`、`erasableSyntaxOnly`、`verbatimModuleSyntax`、`allowImportingTsExtensions`、`module: nodenext`、`noEmit`（型の import に `type` を付け忘れると Node の型除去では実行時に落ち、vitest では通ってしまうため） |
| `Dockerfile` | `node:26-slim`、`npm ci --omit=dev`、`USER node`、`CMD ["node","src/main.ts"]`、`/data` をボリュームに |
| `src/config.ts` | 環境変数の読み込みと検証 |
| `src/db.ts` | SQLite を開き、スキーマを作る |
| `src/crypto.ts` | ランダムトークン、SHA-256、AES-256-GCM の暗号化と復号 |
| `src/store.ts` | SQLite の読み書き（クライアント、認可途中の記録、認可コード、grant とトークン、Mattermost のトークン、投稿の重複防止の記録）と期限切れの掃除 |
| `src/oauth/metadata.ts` | 2 つのメタデータ |
| `src/oauth/register.ts` | DCR |
| `src/oauth/authorize.ts` | 認可要求の検証、同意画面、同意の受け付け、Mattermost からのコールバック |
| `src/oauth/pages.ts` | 同意画面とエラーページの HTML（エスケープ）と応答ヘッダー |
| `src/oauth/token.ts` | トークンエンドポイント |
| `src/oauth/redirect.ts` | リダイレクト URI の登録可否と完全一致の判定 |
| `src/mattermost/upstream.ts` | Mattermost の OAuth（認可 URL の組み立て、コード交換、リフレッシュ） |
| `src/mattermost/client.ts` | 利用者ごとの API 呼び出し（トークンの読み出し、`401` 時の再読込とリフレッシュ、タイムアウト、エラー分類） |
| `src/mattermost/limiter.ts` | 同時実行とレート制限 |
| `src/mcp/auth.ts` | ベアラートークンの検証、`WWW-Authenticate`、`Origin` の検証 |
| `src/mcp/server.ts` | `McpServer` の組み立てとツールの登録、Streamable HTTP の受け口 |
| `src/mcp/resolve.ts` | チャンネルとユーザーの指定の解決 |
| `src/mcp/format.ts` | 出力の整形、本文の切り詰め、カーソル |
| `src/mcp/tools-read.ts` | 読み取り系の 6 ツール |
| `src/mcp/tools-send.ts` | `send_message` と重複防止 |
| `src/log.ts` | JSON の 1 行ログ |
| `src/app.ts` | Express アプリの組み立て（すべてのルート） |
| `src/main.ts` | 起動、定期掃除 |
| `src/admin.ts` | 管理コマンド（`purge-credentials`、`list-clients`、`delete-client`） |
| `test/unit/*.test.ts` | Mattermost なしで動くテスト（Mattermost は `fetch` のスタブ） |
| `test/int/*.test.ts` | ローカルの Mattermost を使う結合テスト |
| `dev/compose.yml`、`dev/setup.ts` | ローカルの Mattermost と PostgreSQL、初期データ（管理者、利用者 2 人、チーム 2 つ、OAuth アプリ） |
| `../mattermost-infra/compose/docker-compose.yml`、`../mattermost-infra/compose/env.example` | `mcp` サービス、nginx のネットワークエイリアス、`.env` の項目 |
| `../mattermost-infra/nginx/mattermost.conf`、`../mattermost-infra/tests/nginx-mcp.test.sh` | MCP のパスの `location`、`ssl_early_data off`、`limit_req`、本文の上限 |
| `docs/runbook.md` | 本番投入、確認、スナップショットからの復元、Mattermost 更新時の手順 |

---

### Task 1: プロジェクトの土台とローカルの Mattermost

**Files:**
- Create: `package.json`、`package-lock.json`、`tsconfig.json`、`vitest.config.ts`、`src/config.ts`、`src/deps.ts`、`dev/compose.yml`、`dev/setup.ts`、`test/unit/config.test.ts`、`test/int/helpers.ts`、`test/int/mattermost-oauth.test.ts`、`docs/runbook.md`（見出しだけ）

**Interfaces:**
- Produces:
  - `type Config = { publicUrl: string; resource: string; issuer: string; mmUrl: string; mmBrowserUrl: string; mmClientId: string; mmClientSecret: string; encKey: Buffer; dbPath: string; port: number; accessTokenTtlSec: number; extraRedirectUris: string[]; extraOrigins: string[] }`
  - `loadConfig(env: NodeJS.ProcessEnv): Config`（`PUBLIC_URL`、`MM_URL`（サーバーから API を呼ぶ先。省略時は `PUBLIC_URL`）、`MM_BROWSER_URL`（利用者のブラウザを送る Mattermost の URL とパーマリンクの起点。省略時は `MM_URL`）、`MM_OAUTH_CLIENT_ID`、`MM_OAUTH_CLIENT_SECRET`、`TOKEN_ENC_KEY`（base64 で 32 バイト）、`DB_PATH`（既定 `/data/mcp.sqlite`）、`PORT`（既定 3000）、`ACCESS_TOKEN_TTL_SEC`（既定 3600）、`EXTRA_REDIRECT_URIS`、`EXTRA_ALLOWED_ORIGINS`。`resource` と `issuer` は `${publicUrl}/mcp`）
  - `deps.ts`: `type Deps = { fetch: typeof fetch; now: () => number }`。Mattermost を呼ぶすべての関数（`upstream.ts`、`MmClient`、OAuth のコールバック）はこの `fetch` を使い、単体テストはスタブを渡す
  - `test/int/helpers.ts`: `env(): { mmUrl; adminToken; users: { alice: Cred; bob: Cred }; teams: { a: Team; b: Team }; oauth: { clientId; clientSecret; callback } }`（`dev/setup.ts` が書き出す `dev/.state.json` を読む）、`mmLoginCookie(user): Promise<string>`、`mmAuthorizeCode(cookie, params): Promise<string>`（Mattermost の `/oauth/authorize` を Cookie 付きで叩き、リダイレクト先のコードを返す）

- [ ] **Step 1: `config.test.ts` を書く**

```ts
test('derives resource and issuer from PUBLIC_URL', () => {
  const c = loadConfig({ PUBLIC_URL: 'https://mm.example', MM_OAUTH_CLIENT_ID: 'id', MM_OAUTH_CLIENT_SECRET: 's', TOKEN_ENC_KEY: Buffer.alloc(32).toString('base64') });
  expect(c.resource).toBe('https://mm.example/mcp');
  expect(c.issuer).toBe('https://mm.example/mcp');
  expect(c.mmUrl).toBe('https://mm.example');
});
test('rejects a key that is not 32 bytes', () => { expect(() => loadConfig({ ...base, TOKEN_ENC_KEY: 'AAAA' })).toThrow(/TOKEN_ENC_KEY/); });
test('rejects PUBLIC_URL with trailing slash', () => { expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://mm.example/' })).toThrow(/PUBLIC_URL/); });
```

- [ ] **Step 2:** `npx vitest run test/unit/config.test.ts` が失敗することを確かめる
- [ ] **Step 3:** `loadConfig` を実装し、Step 2 のテストが通ることを確かめる
- [ ] **Step 4:** `package.json` の `dev:up`（ローカルの Mattermost を起動して `dev/setup.ts` を実行）と `dev:down` は、同じ規則（環境変数 `MATTERMOST_IMAGE_TAG`、`../mattermost-infra/compose/.env`、`../mattermost-infra/compose/env.example` の順、どれもなければ失敗）でバージョンを決める。`dev/compose.yml` を書く。`mattermost/mattermost-team-edition:${MATTERMOST_IMAGE_TAG}`（環境変数 `MATTERMOST_IMAGE_TAG` を優先し、未指定なら隣の `../mattermost-infra/compose/.env`、それもなければ `../mattermost-infra/compose/env.example` の値を使う。どれもなければ起動を失敗させる。固定値に落とすと、Mattermost の更新後も古い版で黙ってテストが通ってしまうため）と `postgres:18.6`。Mattermost の `MM_SERVICESETTINGS_SITEURL=http://localhost:8065`、`MM_SERVICESETTINGS_ENABLEOAUTHSERVICEPROVIDER=true`、`MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS=true`、`MM_SERVICESETTINGS_ENABLELOCALMODE=true`、`MM_RATELIMITSETTINGS_ENABLE=false`、ポート 8065 をホストに公開
- [ ] **Step 5:** `dev/setup.ts` を書く。REST API で管理者、`alice`、`bob`、チーム `team-a` と `team-b`（両方に同名チャンネル `general-dup`）、`alice` だけが入る非公開チャンネル、OAuth アプリ（confidential、`is_trusted: true`、コールバック `http://localhost:3000/mcp/oauth/callback`）を作り、`dev/.state.json` に書き出す。再実行しても重複して作らない
- [ ] **Step 6:** `docker compose -f dev/compose.yml up -d && node dev/setup.ts` で初期データができ、`curl -s localhost:8065/api/v4/system/ping` が `"status":"OK"` を返すことを確かめる
- [ ] **Step 7: `mattermost-oauth.test.ts` を書く（設計の前提の確認）**

```ts
test('re-authorizing the same user and app returns the same token pair', async () => {
  const t1 = await exchange(await mmAuthorizeCode(cookie, p)); const t2 = await exchange(await mmAuthorizeCode(cookie, p));
  expect(t2.access_token).toBe(t1.access_token); expect(t2.refresh_token).toBe(t1.refresh_token);
});
test('refresh invalidates the old access token and rotates the refresh token', async () => {
  const r = await refresh(t1.refresh_token);
  expect(r.refresh_token).not.toBe(t1.refresh_token);
  expect((await me(t1.access_token)).status).toBe(401);
  expect((await me(r.access_token)).status).toBe(200);
});
test('refresh with a used refresh token fails with invalid_grant-like 4xx', async () => { expect((await refreshRaw(t1.refresh_token)).status).toBeGreaterThanOrEqual(400); });
test('refresh after the user deauthorizes the app fails (record status and error id)', async () => {
  // POST /oauth/deauthorize（利用者の Cookie と、Mattermost の CSRF 対策のため X-Requested-With: XMLHttpRequest と X-CSRF-Token ヘッダーで。helpers に関数を置く）→ refreshRaw → v11.7.8 のソースでは 404 と id api.oauth.get_access_token.refresh_token.app_error
});
test('refresh after the user is deactivated fails (record status and error id)', async () => {
  // 管理者で DELETE /api/v4/users/{id} → refreshRaw → v11.7.8 のソースからの見込みは 404 と id api.oauth.get_access_token.refresh_token.app_error（無効化で OAuthAccessData も消えるため）。実測で確定する
});
test('same pending_post_id within 30s yields one post', async () => {
  const a = await createPost(tok, { channel_id, message: 'x', pending_post_id: pid }); const b = await createPost(tok, { channel_id, message: 'x', pending_post_id: pid });
  expect(b.id).toBe(a.id);
});
```

- [ ] **Step 8:** `npm run test:int -- mattermost-oauth` を実行し、結果を記録する。6 つが通れば前提どおり。通らないものがあれば、その挙動（トークン交換とリフレッシュの必須パラメータ、エラーの HTTP ステータスと `error` 値を含む）を `docs/runbook.md` の「Mattermost の OAuth の実測」に書き、設計の前提と食い違う場合は先へ進まず利用者に報告する。食い違わない場合も、後続の Task が使う実測値（リフレッシュ要求に `redirect_uri` が要るか、取り消し・無効化・使用済みのときのステータスとエラー `id`）を同じ節に書く。Task 4 の `refreshTokens` が「再ログインが要る」と判定する条件は、この実測値だけとする

### Task 2: SQLite、暗号化、ストア

**Files:**
- Create: `src/db.ts`、`src/crypto.ts`、`src/store.ts`、`test/unit/crypto.test.ts`、`test/unit/store.test.ts`

**Interfaces:**
- Consumes: `Config`
- Produces:
  - `crypto.ts`: `randomToken(): string`（32 バイト、base64url）、`sha256(s: string): string`（hex）、`seal(key: Buffer, plain: string): string`、`open(key: Buffer, sealed: string): string`（AES-256-GCM、`iv.tag.ciphertext` の base64url）
  - `db.ts`: `openDb(path: string): DatabaseSync`（`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`、スキーマを `CREATE TABLE IF NOT EXISTS` で作る）
  - `store.ts`: `class Store`（コンストラクタ `(db: DatabaseSync, encKey: Buffer, now: () => number = Date.now)`）。メソッドは下表

| メソッド | 内容 |
|---|---|
| `createClient(meta: ClientMeta): Client` | `client_id` は `randomToken()`。`authorized_at` は null。作成後、未認可が 500 件を超えたら最古の未認可から削除 |
| `getClient(id): Client \| undefined`、`markClientAuthorized(id)` | |
| `createAuthSession(s: AuthSessionInput): { sessionId; cookieSecret; csrf }` | 認可途中の記録。MCP クライアントの `client_id`・`redirect_uri`・`code_challenge`・`state`・`resource`・`scope` を保存 |
| `approveAuthSession(sessionId, cookieSecret, csrf): { upstreamState, upstreamVerifier } \| undefined` | Cookie の値と CSRF を照合し、上流用の `state` と PKCE verifier を生成して保存 |
| `findSessionIdByUpstreamState(upstreamState): string \| undefined`、`takeAuthSession(sessionId, cookieSecret, upstreamState): AuthSession \| undefined` | 1 回だけ取り出して消す。600 秒を過ぎているか、Cookie の値か `state` が合わなければ undefined |
| `createCode(c: CodeInput): string` | 平文コードを返し、ハッシュを保存。`mm_user_id`、`client_id`、`redirect_uri`、`code_challenge`、`resource`、`scope` を結び付ける |
| `consumeCode(code): CodeRecord \| 'reused' \| undefined` | トランザクションで消費済みにして返す。消費済みなら `'reused'` を返し、そのコードから作った grant を失効させる |
| `createGrant(g: { mmUserId; clientId; scope; resource; fromCodeHash }): { accessToken; refreshToken; expiresIn }` | |
| `rotateRefresh(refreshToken, clientId, resource): { accessToken; refreshToken; expiresIn } \| 'reused' \| undefined` | トランザクションで旧トークンを使用済みにし新しい組を発行、grant の最終利用時刻を更新。使用済みなら grant ごと失効して `'reused'` |
| `verifyAccess(accessToken): { grantId; mmUserId; clientId; scope } \| undefined` | |
| `revokeUser(mmUserId)` | その利用者の grant、トークン、Mattermost のトークンを消す |
| `getMmCred(mmUserId): { access; refresh; version } \| undefined`、`putMmCred(mmUserId, access, refresh)`、`casMmCred(mmUserId, expectedVersion, access, refresh): boolean` | 暗号化して保存。`version` は更新ごとに 1 増える |
| `claimPost(k: { mmUserId; channelId; rootId; bodyHash }): PostClaim` | 下記の `send_message` の状態遷移 |
| `completePost(id, postId)`、`dropPost(id)` | |
| `purgeCredentials()` | クライアント以外の全テーブルを空にする |
| `sweep()` | 期限切れの記録を消す |

  - `type PostClaim = { kind: 'new'; id; pendingPostId } | { kind: 'done'; postId } | { kind: 'inflight' } | { kind: 'retry'; id; pendingPostId; createdAt }`

- [ ] **Step 1: テストを書く**

```ts
test('seal/open round trip and tamper detection', () => { const s = seal(k, 'x'); expect(open(k, s)).toBe('x'); expect(() => open(k, flipLastChar(s))).toThrow(); });
test('code is single use and reuse revokes the grant', () => { /* createCode → consumeCode ok → createGrant → consumeCode again === 'reused' → verifyAccess(grant.accessToken) undefined */ });
test('refresh rotation detects reuse and revokes the family', () => { /* r1 → rotate → r2; rotate(r1) === 'reused'; rotate(r2) undefined; verifyAccess(latest access) undefined */ });
test('refresh extends idle expiry and expires after 90 idle days', () => { /* now を進める: 89 日後の rotate は成功、その後 90 日 + 1 秒後は undefined */ });
test('auth session is single use and expires after 600s', () => {});
test('unauthorized clients are evicted oldest-first beyond 500, authorized ones are kept', () => {});
test('sweep removes unauthorized clients older than 7 days but keeps authorized ones', () => {});
test('casMmCred fails when version changed', () => {});
test('sealed Mattermost tokens are not stored in plain text', () => { /* DB の生の値に access の文字列が含まれない */ });
test('claimPost: new → inflight within 30s → retry after 30s (only one claimer) → done', () => {});
test('purgeCredentials keeps clients', () => {});
```

- [ ] **Step 2:** `npx vitest run test/unit/crypto.test.ts test/unit/store.test.ts` が失敗することを確かめる
- [ ] **Step 3:** 実装する。`claimPost` は 600 秒以内の同じ組の記録を見て、なければ `new`、成功済みなら `done`、投稿中で `updated_at` から 30 秒未満なら `inflight`、30 秒以上なら `UPDATE ... SET updated_at = now WHERE id = ? AND updated_at = ?` の更新件数が 1 のときだけ `retry`、0 なら `inflight`
- [ ] **Step 4:** Step 2 のテストが通ることを確かめる

### Task 3: メタデータと DCR

**Files:**
- Create: `src/oauth/metadata.ts`、`src/oauth/register.ts`、`src/oauth/redirect.ts`、`src/app.ts`、`src/log.ts`、`test/unit/redirect.test.ts`、`test/unit/register.test.ts`、`test/unit/metadata.test.ts`

**Interfaces:**
- Consumes: `Config`、`Store`
- Produces:
  - `redirect.ts`: `isRegistrable(uri: string, extra: string[]): boolean`、`matchesRegistered(requested: string, registered: string[]): boolean`（ループバックはポートだけ無視し、スキーム、ホスト、パス、クエリを完全一致）
  - `app.ts`: `createApp(ctx: { config: Config; store: Store; deps: Deps }): express.Express`。後続の Task はここにルートを足す（Task 6 以降は `ctx` に `mm: MmClient` も加える）
  - `log.ts`: `log(event: string, fields: Record<string, string | number | boolean | undefined>): void`

- [ ] **Step 1: テストを書く**

```ts
test.each(['https://claude.ai/api/mcp/auth_callback','https://claude.com/api/mcp/auth_callback','http://localhost:5555/callback','http://127.0.0.1:1/x'])('registrable %s', u => expect(isRegistrable(u, [])).toBe(true));
test.each(['http://localhost.evil.com/cb','https://claude.ai/api/mcp/auth_callback/../x','https://claude.ai.evil/api/mcp/auth_callback','http://[::1]:5/cb','https://localhost/cb','javascript:alert(1)'])('not registrable %s', u => expect(isRegistrable(u, [])).toBe(false));
test('loopback matches with a different port only', () => {
  expect(matchesRegistered('http://127.0.0.1:9999/cb', ['http://127.0.0.1:1234/cb'])).toBe(true);
  expect(matchesRegistered('http://127.0.0.1:9999/cb2', ['http://127.0.0.1:1234/cb'])).toBe(false);
  expect(matchesRegistered('https://claude.ai/api/mcp/auth_callback?x=1', ['https://claude.ai/api/mcp/auth_callback'])).toBe(false);
});
test('PRM', async () => { const r = await get('/.well-known/oauth-protected-resource/mcp'); expect(r.body).toEqual({ resource: 'https://mm.example/mcp', authorization_servers: ['https://mm.example/mcp'], scopes_supported: ['mattermost'], bearer_methods_supported: ['header'] }); });
test('AS metadata', async () => { const b = (await get('/.well-known/oauth-authorization-server/mcp')).body;
  expect(b).toMatchObject({ issuer: 'https://mm.example/mcp', authorization_endpoint: 'https://mm.example/mcp/oauth/authorize', token_endpoint: 'https://mm.example/mcp/oauth/token', registration_endpoint: 'https://mm.example/mcp/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mattermost'] }); });
test('register returns 201 with client_id and echoes metadata', async () => {});
test('register rejects disallowed redirect_uri with invalid_redirect_uri', async () => {});
test('register rejects control chars, name > 100, > 5 uris, uri > 2000 with invalid_client_metadata', async () => {});
test('register stores token_endpoint_auth_method none even if the client asked for another, and says so in the response', async () => {});
```

- [ ] **Step 2:** テストが失敗することを確かめる
- [ ] **Step 3:** 実装する。`register` は `client_name`、`redirect_uris`、`grant_types`（`authorization_code`、`refresh_token` 以外は拒否）、`response_types`、`token_endpoint_auth_method`、`scope` だけを受け取り、それ以外のメタデータ（`logo_uri` など）は保存も返却もしない。要求本文は `express.json({ limit: '16kb' })`。未認可の登録数が 450 件を超えたら `log('dcr_unauthorized_near_limit', …)` を出す
- [ ] **Step 4:** テストが通ることを確かめる

### Task 4: 認可エンドポイント、同意画面、Mattermost からのコールバック

**Files:**
- Create: `src/oauth/authorize.ts`、`src/oauth/pages.ts`、`src/oauth/consent.css`、`src/mattermost/upstream.ts`、`test/unit/authorize.test.ts`、`test/unit/pages.test.ts`

**Interfaces:**
- Consumes: `Store`（`getClient`、`createAuthSession`、`approveAuthSession`、`takeAuthSession`、`createCode`、`putMmCred`、`markClientAuthorized`）、`matchesRegistered`
- Produces:
  - `upstream.ts`: `authorizeUrl(cfg, state: string, challenge: string): string`（`mmBrowserUrl` を使う）、`exchangeCode(cfg, deps, code: string, verifier: string): Promise<MmTokens>`、`refreshTokens(cfg, deps, refresh: string): Promise<MmTokens | 'invalid_grant'>`、`type MmTokens = { access: string; refresh: string }`
    - `'invalid_grant'` を返すのは、Task 1 で実測した「取り消し」「無効化」「使用済み」のステータスとエラー `id` の組（v11.7.8 のソースからの見込みは、取り消し・無効化・使用済みとも `404` と `api.oauth.get_access_token.refresh_token.app_error`。`403` と `api.oauth.get_access_token.expired_code.app_error` は、利用者が無効化されていてアクセスデータが残っている場合）に一致したときだけ
    - それ以外の `4xx`（クライアントシークレットの誤りなど）は `log('mm_refresh_config_error', …)` を出して `UpstreamUnavailable` を投げ、保存情報を変えない。タイムアウト、接続失敗、`5xx` も `UpstreamUnavailable`
  - `pages.ts`: `consentPage(p: { clientName: string; redirectUri: string; loopback: boolean; sessionId: string; csrf: string }): string`（`sessionId` と `csrf` はフォームの hidden に入れる）、`errorPage(message: string): string`、`setPageHeaders(res, formAction: string[])`（Global Constraints の CSP と `X-Frame-Options`）
  - ルート: `GET /mcp/oauth/authorize`、`POST /mcp/oauth/consent`、`GET /mcp/oauth/callback`、`GET /mcp/oauth/consent.css`

- [ ] **Step 1: テストを書く**

```ts
test('unknown client_id or unregistered redirect_uri shows error page, never redirects', async () => { /* status 400, no Location header */ });
test('missing/plain PKCE, missing resource, wrong resource, unknown scope redirect back with error and the original state', async () => {
  // invalid_request（PKCE）、invalid_target（resource）、invalid_scope。Location の state はクライアントが送った値と一致
});
test('scope omitted is treated as mattermost', async () => {});
test('consent page is shown before any upstream redirect and sets __Host- cookie', async () => {
  // 200、Set-Cookie が __Host-mcp_authz_<session_id>=…; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600 で Domain なし、本文に redirect_uri 全体
});
test('consent CSP allows form-action to Mattermost and the client redirect origin only', async () => {
  // claude.ai の場合: form-action 'self' http://mm.example https://claude.ai。ループバックの場合: 'self' <MM> http://127.0.0.1:*。default-src 'none' と frame-ancestors 'none' を含む
});
test('two concurrent authorizations in one browser do not clobber each other', async () => {});
test('consent POST without matching csrf or cookie is rejected', async () => {});
test('consent POST redirects to Mattermost with its own state and S256 challenge', async () => {});
test('callback with mismatched state or cookie is rejected and the session cannot be reused', async () => {});
test('callback exchanges code, stores Mattermost tokens, marks client authorized, redirects with code and client state', async () => {});
test('deny button redirects with access_denied and the client state', async () => {});
test('consent page escapes client_name and redirect_uri', () => {
  const html = consentPage({ clientName: '<script>alert(1)</script>"\'&', redirectUri: 'http://127.0.0.1:1/"><img src=x>', loopback: true, csrf: 'c' });
  expect(html).not.toContain('<script>alert'); expect(html).not.toContain('<img'); expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('名前は登録者の自己申告');  expect(html).toContain('この端末上のアプリ');
  expect(html).not.toMatch(/<script|\son\w+\s*=/i);
});
```

- [ ] **Step 2:** テストが失敗することを確かめる
- [ ] **Step 3:** 実装する。エスケープは `& < > " '` を文字参照に置き換える 1 関数で、テンプレートに入れるすべての値に通す。コールバックでは Mattermost の `/api/v4/users/me` で利用者 ID を得てから `putMmCred` し、`createCode` する。Mattermost がエラーで戻ってきた場合は MCP クライアントへ `access_denied` を返す
- [ ] **Step 4:** テストが通ることを確かめる

### Task 5: トークンエンドポイント

**Files:**
- Create: `src/oauth/token.ts`、`test/unit/token.test.ts`、`test/int/oauth-flow.test.ts`

**Interfaces:**
- Consumes: `Store`（`consumeCode`、`createGrant`、`rotateRefresh`）
- Produces: `POST /mcp/oauth/token`（`application/x-www-form-urlencoded`）。応答 `{ access_token, token_type: 'Bearer', expires_in: <config.accessTokenTtlSec>, refresh_token, scope: 'mattermost' }`、`Cache-Control: no-store`

- [ ] **Step 1: テストを書く**

```ts
test('code exchange checks client_id, redirect_uri and PKCE (invalid_grant), resource (invalid_target)', async () => {});
test('code reuse returns invalid_grant and revokes tokens issued from it', async () => {});
test('expired code (61s) is rejected', async () => {});
test('refresh rotates; old refresh token reuse returns invalid_grant and kills the family', async () => {});
test('refresh with another client_id is rejected', async () => {});
test('refresh cannot widen scope', async () => { /* scope=mattermost other → invalid_scope */ });
// 結合テスト（ローカルの Mattermost）
test('full flow: register → authorize → consent → Mattermost login → callback → token → refresh', async () => {});
```

- [ ] **Step 2:** テストが失敗することを確かめる
- [ ] **Step 3:** 実装する。エラーは RFC 6749 の形式（`{ error, error_description }`、`400`）。`unsupported_grant_type` も返す
- [ ] **Step 4:** `npm test` と `npm run test:int -- oauth-flow` が通ることを確かめる

### Task 6: Mattermost API クライアント（トークン共有、リフレッシュ、制限）

**Files:**
- Create: `src/mattermost/client.ts`、`src/mattermost/limiter.ts`、`test/unit/client.test.ts`、`test/unit/limiter.test.ts`、`test/int/client.test.ts`

**Interfaces:**
- Consumes: `Store`（`getMmCred`、`casMmCred`、`revokeUser`）、`refreshTokens`
- Produces:
  - `limiter.ts`: `class Limiter`（`(opts: { perUserConcurrency: 4; globalConcurrency: 16; perUserPerMin: 120; globalPerMin: 600 }, now)`）、`acquire(mmUserId): Release`（上限なら待たずに `RateLimited` を投げる。`RateLimited` は `retryAfterSec` を持つ）
  - `client.ts`: `class MmClient`（`(cfg, store, limiter, deps: Deps)`）、`call<T>(mmUserId: string, method: string, path: string, body?: unknown): Promise<T>`。エラーは `UpstreamUnavailable`（一時的）、`Reauthorize`（再ログインが要る）、`RateLimited`、`MmError`（`status` と Mattermost の `id`／`message` を持つ `4xx`）。どのエラーも、Mattermost へ要求を送る前に起きたかどうかを `sent: boolean` で持つ
- 振る舞い:
  - 1 回の `call` ごとに `limiter.acquire` を 1 回（Mattermost API の呼び出し 1 回ごとに数える）
  - `401` を受けたら `getMmCred` を読み直し、`version` が変わっていればそのトークンで 1 回だけ再試行。変わっていなければユーザー単位の single-flight でリフレッシュし、`casMmCred` で保存してから 1 回だけ再試行
  - Mattermost でのリフレッシュが成功した後に `casMmCred` が失敗した（同時に完了したログインのコールバックが `putMmCred` した）場合は、リフレッシュで得たトークンで API を 1 回試し、成功すればそれを `putMmCred` で保存する。失敗した場合だけ、読み直した保存値で再試行する。Mattermost では利用者とアプリの組に有効なトークンが 1 組しかなく、コールバックが保存した値がこのリフレッシュで無効になった旧い組の可能性があるため
  - リフレッシュが `invalid_grant` なら `revokeUser` して `Reauthorize`。再試行後も `401` なら同じ
  - `429` は再試行せず `RateLimited`（`X-RateLimit-Reset` から `retryAfterSec`）
  - タイムアウト 20 秒、接続失敗、`5xx` は `UpstreamUnavailable`（保存情報は変えない）

- [ ] **Step 1: テストを書く（`fetch` はスタブ）**

```ts
test('shared credential survives refresh by another grant', async () => { /* 2 つの同時 call が 401 → refresh は 1 回だけ、両方成功 */ });
test('reloads newer credential before refreshing', async () => {});
test('transient upstream failure keeps grants', async () => { /* 503 と ECONNREFUSED とタイムアウトで UpstreamUnavailable、store に変化なし */ });
test('revoked app forces relogin', async () => { /* refresh が invalid_grant → Reauthorize、verifyAccess も getMmCred も undefined */ });
test('other 4xx on refresh (bad client secret) keeps grants and credentials', async () => {});
test('429 is not retried', async () => {});
test('limiter rejects immediately beyond per-user and global limits', () => {});
// 結合テスト（test/int/client.test.ts、ローカルの Mattermost）
test('deauthorize in Mattermost leads to Reauthorize and revoked grants', async () => {});
test('deactivated user leads to Reauthorize and revoked grants', async () => {});
test('expired Mattermost access token is refreshed transparently', async () => {
  // セッションの取り消しは OAuthAccessData（リフレッシュトークン）まで消すので使わない。
  // 列名は先に psql の \d sessions で確かめる。ローカルの PostgreSQL で UPDATE sessions SET expiresat = <過去> WHERE token = <access> を実行し、管理者で POST /api/v4/caches/invalidate を呼んでから call → 成功し、保存されたトークンが替わる
});
```

- [ ] **Step 2:** テストが失敗することを確かめる
- [ ] **Step 3:** 実装する
- [ ] **Step 4:** テストが通ることを確かめる

### Task 7: MCP の受け口とローカルでのクライアント接続確認

**Files:**
- Create: `src/mcp/auth.ts`、`src/mcp/server.ts`、`src/main.ts`、`test/unit/mcp-auth.test.ts`、`test/int/mcp-endpoint.test.ts`
- Modify: `src/app.ts`（`/mcp`、`/mcp/healthz` を追加）

**Interfaces:**
- Consumes: `Store.verifyAccess`、`MmClient`
- Produces:
  - `auth.ts`: `requireBearer(cfg, store): express.RequestHandler`（成功時 `res.locals.auth = { grantId, mmUserId, clientId }`。SDK が `req.auth` を独自の `AuthInfo` 型で使うため、`req.auth` には置かない）、`checkOrigin(allowed: string[]): express.RequestHandler`
  - `server.ts`: `buildServer(ctx: { mm: MmClient; mmUserId: string; cfg: Config; store: Store }): McpServer`（要求ごとに作る）、`registerTool` の呼び出しは Task 8 と 9 が足す
  - `main.ts`: `loadConfig` → `openDb` → `createApp` → `listen(port)`、60 秒ごとに `store.sweep()`
- 振る舞い:
  - トークンなし・無効なら `401` と `WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource/mcp", scope="mattermost"`。無効なトークンには `error="invalid_token"` も付ける
  - `Origin` があり許可リストにない要求は `403`
  - `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` を要求ごとに作る（stateless。通知を送らないので SSE は使わず、応答は `application/json` で返す。SSE を使わないことで、中継するプロキシやトンネルのバッファリングの影響も受けない）。`GET` と `DELETE` は `405`
  - ツールが `Reauthorize` を投げたら、その呼び出しはツールの結果 `isError: true` と「Mattermost への再ログインが必要。コネクタを再接続してください」を返す（SDK の Streamable HTTP は応答のステータスを先に `200` で確定させるため、同じ要求で `401` は返せない）。`Reauthorize` の時点で `revokeUser` により grant が消えているので、次の HTTP 要求で `requireBearer` が `401`（`error="invalid_token"`）を返し、クライアントが再ログインを始める。他のエラーもツールの結果 `isError: true` にする
  - ツール呼び出しごとに `log('tool_call', { mm_user_id, tool, outcome, ms })`

- [ ] **Step 1: テストを書く**

```ts
test('401 with resource_metadata and scope when no token', async () => {});
test('403 for disallowed Origin, accepted without Origin', async () => {});
test('initialize and tools/list over Streamable HTTP with a valid token return application/json', async () => {});
test('healthz returns 200 without auth', async () => {});
test('after Reauthorize in a tool call, the next request gets 401 invalid_token', async () => {});
```

- [ ] **Step 2:** テストが失敗することを確かめる
- [ ] **Step 3:** 実装し、テストが通ることを確かめる
- [ ] **Step 4: 3 クライアントでの接続確認（パス付き issuer の探索とリフレッシュの早期確認）**。claude.ai はインターネットから届く HTTPS の URL が要るため、3 つとも一時的な HTTPS トンネルで確かめる
  - `brew install cloudflared` し、`cloudflared tunnel --url http://localhost:3000` で得た `https://<ランダム>.trycloudflare.com` を `PUBLIC_URL` にする。トンネルは確認が終わったらすぐ止める（公開されるのはローカルのテスト用データだけ）
  - `node dev/setup.ts --callback <PUBLIC_URL>/mcp/oauth/callback` でローカルの Mattermost の OAuth アプリのコールバックを合わせる（`setup.ts` にこの引数を足す）
  - `PUBLIC_URL=<トンネル> MM_URL=http://localhost:8065 MM_BROWSER_URL=http://localhost:8065 ACCESS_TOKEN_TTL_SEC=120 …` で `node src/main.ts` を起動する。ダミーのツール 1 つ（`whoami`、Mattermost の `users/me` を返す。Task 8 で消す）を登録しておく
  - claude.ai: 設定 > コネクタ > カスタムコネクタを追加 で `<PUBLIC_URL>/mcp` を登録 → 接続 → 会話で `whoami` が `alice` を返す
  - Claude Code: `claude mcp add --transport http mm-local <PUBLIC_URL>/mcp` → `/mcp` から認証 → `whoami` が `alice` を返す
  - Codex CLI: `~/.codex/config.toml` に `[mcp_servers.mm-local] url = "<PUBLIC_URL>/mcp"` → `codex mcp login mm-local` → 認可が完了する（Codex の利用枠がなくログイン以降を確かめられない場合はその旨を書く）
  - 3 つとも、2 分以上待ってから再び `whoami` を呼び、再ログインなしでリフレッシュされて動くことを確かめる（Codex は利用枠があれば）
  - サーバーのログで、各クライアントが `/.well-known/oauth-authorization-server/mcp` を取得したこと、認可要求、トークン要求、リフレッシュ要求のそれぞれに `resource` と `scope` を送っていることを確かめる（確認用のログを一時的に足すなら、Task の終わりに消す）
  - 確認が終わったらトンネルを止め、`node dev/setup.ts --callback http://localhost:3000/mcp/oauth/callback` で OAuth アプリのコールバックを戻す（後続の結合テストがこの値を前提とするため）
  - 結果を `docs/runbook.md` の「クライアント互換性」に書く。どれかが接続またはリフレッシュできなかったら、原因を調べて回避策を試し、回避できなければ先へ進まず利用者に報告する（設計書の「認可サーバーの URL」と「`resource` の扱い」）

### Task 8: 読み取り系のツール

**Files:**
- Create: `src/mcp/resolve.ts`、`src/mcp/format.ts`、`src/mcp/tools-read.ts`、`test/unit/format.test.ts`、`test/unit/resolve.test.ts`、`test/int/tools-read.test.ts`
- Modify: `src/mcp/server.ts`（ダミーの `whoami` を消し、読み取り系を登録）

**Interfaces:**
- Consumes: `MmClient.call`
- Produces:
  - `resolve.ts`: `resolveChannel(mm, userId, spec: string): Promise<ChannelRef>`（チャンネル ID（26 文字の英数字）、`team/channel`、`channel`、`@user` の順に判定。候補が 2 つ以上なら `Ambiguous`（候補の `team`、`name`、`id` の配列）を投げる）、`resolveUser(mm, userId, spec: string): Promise<UserRef>`、`type ChannelRef = { id; name; displayName; teamId; teamName }`
  - `format.ts`: `truncate(s: string, max = 4000): { text: string; truncated: boolean }`（`Intl.Segmenter` による書記素クラスタ単位で数えて切る）、`formatPost(p, ctx): string`（投稿者 `@username`、ISO 8601 の UTC と JST の併記、本文、`https://…/<team>/pl/<post_id>`）、`encodeCursor(o: object): string`、`decodeCursor(s: string): object`（base64url の JSON、不正なら入力エラー）
  - ツール（すべて `annotations: { readOnlyHint: true }`、入力は zod）:
    - `search_posts({ terms: string, limit?: number, cursor?: string })`: 全チームを 1 回で検索する `POST /api/v4/posts/search`（v11.7.8 の `searchPostsInAllTeams`）を `page`／`per_page` で呼ぶ。カーソルは `{ page, per_page }` とし、2 ページ目以降はカーソルの `per_page` を使う（途中で `limit` を変えても抜けや重複が出ないように）。チームごとに呼んで統合する方式は、重複と API 呼び出し数の増加を招くので採らない
    - `read_channel({ channel: string, limit?, cursor? })`: 新しい順
    - `read_thread({ post_id: string, limit?, cursor? })`: 古い順、親投稿は最初のページだけ
    - `search_channels({ query: string, limit?, cursor? })`
    - `search_users({ query: string, limit?, cursor? })`
    - `get_user({ user: string })`
  - 出力の末尾に、続きがあれば `next_cursor: <値>`、本文を切った投稿があれば `（本文を 4000 文字で切った投稿があります）` を書く。チャンネルとチームの ID と名前を出力に含める

- [ ] **Step 1: テストを書く**

```ts
test('truncation keeps grapheme clusters', () => {
  const s = '👨‍👩‍👧'.repeat(4001); const r = truncate(s);
  expect([...new Intl.Segmenter().segment(r.text)].length).toBe(4000); expect(r.truncated).toBe(true); expect(r.text.endsWith('👨‍👩‍👧')).toBe(true);
  expect(truncate('a'.repeat(4000))).toEqual({ text: 'a'.repeat(4000), truncated: false });
});
test('resolve team/channel, bare name, @user DM, id', async () => {});
test('bare name in two teams throws Ambiguous with both candidates', async () => {});
// 結合テスト
test('read_channel paginates without gaps or duplicates', async () => {});
test('read_thread returns parent only on first page, ascending', async () => {});
test('private channel of alice is invisible to bob', async () => {});
test('search_posts spans both teams', async () => {});
test('Mattermost API calls per tool are counted by the limiter', async () => {});
```

- [ ] **Step 2:** テストが失敗することを確かめる
- [ ] **Step 3:** 実装し、`npm test` と `npm run test:int -- tools-read` が通ることを確かめる

### Task 9: `send_message` と二重投稿の防止

**Files:**
- Create: `src/mcp/tools-send.ts`、`test/unit/send.test.ts`、`test/int/tools-send.test.ts`
- Modify: `src/mcp/server.ts`

**Interfaces:**
- Consumes: `resolveChannel`、`Store.claimPost`／`completePost`／`dropPost`、`MmClient.call`
- Produces: `send_message({ channel: string, message: string, root_id?: string, allow_duplicate?: boolean })`、`annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }`
- 振る舞い:
  - 投稿先が名前で一意に決まらなければ `Ambiguous` を結果として返し、投稿しない
  - `root_id` があれば `GET /api/v4/posts/{root_id}` でそのチャンネルにあることを確かめる
  - `allow_duplicate` でなければ `claimPost`。`done` は前回の投稿を返す、`inflight` は「同じ投稿を処理中」のエラー、`retry` は `GET /api/v4/channels/{id}/posts?since=<createdAt>` で、その利用者、同じ `root_id`、本文完全一致の投稿を探し、見つかれば `completePost` して返す。見つからなければ同じ `pendingPostId` で投稿
  - 投稿 `POST /api/v4/posts`（`pending_post_id` 付き）。成功で `completePost`。`MmError`（4xx）と、Mattermost へ送る前に起きたエラー（`sent: false` の `RateLimited` など）では `dropPost`。それ以外（送った後のタイムアウト、`5xx`）は記録を残す

- [ ] **Step 1: テストを書く**

```ts
test('ambiguous channel name is rejected for send_message', async () => {});
test('root_id in another channel is rejected', async () => {});
test('retry after a lost response does not double post', async () => { /* スタブ: POST は成功させてから例外 → 同じ呼び出しを 31 秒後に再実行 → POST は呼ばれず前回の投稿を返す */ });
test('concurrent identical calls post once', async () => {});
test('allow_duplicate posts again', async () => {});
test('rate limited before sending drops the claim so an immediate retry is not blocked', async () => {});
// 結合テスト（ローカルの Mattermost）
test('posts to a thread and returns permalink', async () => {});
test('same body twice within 10 minutes posts once', async () => {});
```

- [ ] **Step 2:** テストが失敗することを確かめる
- [ ] **Step 3:** 実装し、`npm test` と `npm run test:int -- tools-send` が通ることを確かめる

### Task 10: 管理コマンド

**Files:**
- Create: `src/admin.ts`、`test/unit/admin.test.ts`

**Interfaces:**
- Consumes: `openDb`、`Store`
- Produces: `node src/admin.ts <command>`。`purge-credentials`（`Store.purgeCredentials`、件数を表示）、`list-clients [--unauthorized]`（`client_id`、名前、作成日時、認可済みか）、`delete-client <client_id>`。`DB_PATH`（未設定なら `/data/mcp.sqlite`）だけを読み、`TOKEN_ENC_KEY` などの他の環境変数を要求しない（作業用 VM で `--network none` のまま動かすため）

- [ ] **Step 1:** `purge-credentials` の後にクライアントが残り、grant、トークン、Mattermost のトークン、認可途中の記録、投稿の記録が 0 件になるテストを書く。`DB_PATH` 以外の環境変数なしで動くテストも書く
- [ ] **Step 2:** テストが失敗することを確かめ、実装し、通ることを確かめる

### Task 11: コンテナ、Compose、nginx

**Files:**
- Create: `Dockerfile`、`.dockerignore`、`../mattermost-infra/tests/nginx-mcp.test.sh`
- Modify: `../mattermost-infra/compose/docker-compose.yml`、`../mattermost-infra/compose/env.example`、`../mattermost-infra/nginx/mattermost.conf`（`mattermost-infra` 側はコミットしない。変更はこのリポジトリに次の 2 つとしてコミットし、レビューと本番への配布に使う）
  - `deploy/mattermost-infra.base/`: Task 11 に着手する前に、`mattermost-infra` の `compose/docker-compose.yml`、`compose/env.example`、`nginx/mattermost.conf` をこのディレクトリに同じ相対パスでコピーしてコミットする（変更前の版の固定）
  - `deploy/mattermost-infra.patch`: 接頭辞を揃えた差分。一時ディレクトリに `a/`（`deploy/mattermost-infra.base/` の中身）と `b/`（`../mattermost-infra` の同じ 3 ファイルと `tests/nginx-mcp.test.sh` を同じ相対パスで）を作り、その中で `diff -ruN a b > <リポジトリ>/deploy/mattermost-infra.patch` とする（`/opt/mattermost-infra` で `patch -p1` が当たる形）。`mattermost-infra` を最後に触った後に作り直してコミットする。作ったパッチは、`deploy/mattermost-infra.base/` のコピーに `patch -p1 --dry-run` が通ることを確かめる
  - パッチは配布物で、切り戻しの基準ではない（切り戻しは Task 12 の `.pre-mcp` で行う）

**Interfaces:**
- Produces:
  - Compose の `mcp` サービス: `build: ../../mattermost-mcp`、`restart: unless-stopped`、`security_opt: no-new-privileges:true`、`read_only: true`、`tmpfs: /tmp`、`volumes: /srv/mcp:/data`、`environment`（`PUBLIC_URL`、`MM_OAUTH_CLIENT_ID`、`MM_OAUTH_CLIENT_SECRET`、`TOKEN_ENC_KEY`、`DB_PATH=/data/mcp.sqlite`）、Global Constraints のリソース上限と `logging`、`healthcheck`（`node -e "fetch('http://127.0.0.1:3000/mcp/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`）。ポートは公開しない
  - `mcp` と nginx だけが参加する専用ネットワーク `mcp_net` を作り、nginx のそのネットワークにだけエイリアス `mattermost.example.com` を付ける（`networks: { default: {}, mcp_net: { aliases: [mattermost.example.com] } }`）。`mcp` は `mcp_net` だけに参加する。`default` に付けると `mattermost` コンテナからも自サイトの名前がプライベート IP に解決され、Mattermost の外向き通信（リンクプレビュー、画像プロキシ、自サイト宛ての Webhook、プラグイン）が予約済み IP として拒否されうるため
  - nginx から `mcp` へは `mcp_net` 経由で届く（`set $mcp_upstream http://mcp:3000;`）
  - `env.example` に `MM_OAUTH_CLIENT_ID=`、`MM_OAUTH_CLIENT_SECRET=`、`TOKEN_ENC_KEY=`（生成方法 `openssl rand -base64 32` をコメントで）、`PUBLIC_URL=https://mattermost.example.com`
  - `../mattermost-infra/nginx/mattermost.conf`:
    - `ssl_early_data on;` を `off` にし、`proxy_set_header Early-Data` の 2 行も消す
    - `http` 文脈に `limit_req_zone $binary_remote_addr zone=mcp_oauth:10m rate=60r/m;`
    - `set $mcp_upstream http://mcp:3000;`（既存の `$mattermost_upstream` と同じ実行時解決）
    - `location = /mcp`、`location ^~ /mcp/`（既存の WebSocket 用の正規表現 `location` に負けないよう `^~`）、`location = /.well-known/oauth-protected-resource/mcp`、`location = /.well-known/oauth-authorization-server/mcp` → `$mcp_upstream`。`proxy_buffering off`、`proxy_cache off`、`proxy_read_timeout 120s`、`client_max_body_size 1m`、`X-Forwarded-*` を付ける
    - `location ~ ^/mcp/oauth/(register|authorize|consent|callback|token)$` には `limit_req zone=mcp_oauth burst=30 nodelay;` も付ける
  - `mcp` コンテナは `/srv/mcp` を UID 1000（`node`）で書く。ホスト側で事前に `chown 1000:1000 /srv/mcp`

- [ ] **Step 1: `../mattermost-infra/tests/nginx-mcp.test.sh` を書く**。nginx 1.28 のコンテナに `../mattermost-infra/nginx/mattermost.conf`、空の `access.conf`、自己署名証明書を入れ、`mattermost` と `mcp` の代わりに要求のパスを返すスタブのコンテナを立てて、次を確かめる
  - `nginx -t` が通る
  - `/mcp`、`/mcp/oauth/token`、2 つのメタデータが `mcp` のスタブに届き、`/`、`/api/v4/users/me`、`/.well-known/oauth-authorization-server` が `mattermost` のスタブに届く
  - `mcp` のスタブを止めても nginx が起動し、`/` が応答する
  - `mattermost` のスタブの中で `getent hosts mattermost.example.com` が nginx の `mcp_net` 上のアドレスを返さない（公開 DNS の値が返るのは正常）。`mcp` のスタブの中では nginx の `mcp_net` 上のアドレスを返す
  - `/mcp/x/api/v4/websocket` が `mcp` のスタブに届く
  - `/mcp/oauth/register` に 1 秒で 40 回送ると `503` が混じる
- [ ] **Step 2:** テストが失敗することを確かめ、設定を変え、通ることを確かめる
- [ ] **Step 3:** リポジトリ直下で `docker build -t mattermost-mcp .` が通り、`docker compose -f ../mattermost-infra/compose/docker-compose.yml build mcp` も通り、イメージ内で `node src/admin.ts list-clients` が `DB_PATH=/tmp/x.sqlite` で動くことを確かめる
- [ ] **Step 4: 負荷の確認**。`dev/setup.ts` で負荷用の利用者を 6 人（`load1`〜`load6`）作り、ローカルの Mattermost と `mcp` コンテナ（本番と同じリソース上限）で、6 人が利用者ごとの上限（120 回／分）まで `read_channel` を呼び続け、全体の上限 600 回／分に張り付いた状態にする。その間、別のセッションで Mattermost の `GET /api/v4/users/me` の応答時間の中央値と 95 パーセンタイルを測り、負荷なしの値と比べて `docs/runbook.md` に書く。目に見えて悪化する（95 パーセンタイルが 2 倍を超える）なら、Global Constraints の全体の上限を下げて測り直し、下げた値を計画と設計の具体値として記録する。`docker stats` で `mcp` のメモリが上限の 8 割を超えないことも確かめる

### Task 12: 運用手順書と本番投入

**Files:**
- Modify: `docs/runbook.md`（Task 1 で作り、Task 1、7、11 で書いた節に追記する）

- [ ] **Step 1:** 手順書に次を書く
  - 本番投入: 本番 Mattermost に OAuth アプリを作る（confidential、`is_trusted: true`、コールバック `https://mattermost.example.com/mcp/oauth/callback`）、`mattermost-infra` の `compose/.env` に 4 項目を足す（`TOKEN_ENC_KEY` は VM 上で `openssl rand -base64 32`）、`/srv/mcp` の作成と `chown 1000:1000`、両リポジトリの同期（`/opt/mattermost-mcp` は `feat/mcp-server` をマージした `main` の版を置き、`/opt/mattermost-infra` には `deploy/mattermost-infra.patch` を当てる）。投入前に `/opt/mattermost-mcp` の `git rev-parse HEAD`（git でない置き方なら置いた版のコミット ID）と、当てたパッチの `sha256sum` を「本番投入の記録」に書く。`/opt/mattermost-mcp` は新規の配置なので、切り戻し用の直前の版はない、`docker compose build mcp && docker compose up -d mcp && docker compose up -d nginx`（nginx は設定変更の反映）、`access.conf` で `mcp` コンテナのアドレス（Compose のネットワーク）が拒否されないことの確認
  - 投入前の退避: 本番 VM の `nginx/mattermost.conf` と `compose/docker-compose.yml` を `.pre-mcp` の名前で同じディレクトリにコピーする（`mattermost-infra` にはコミットがなく、前の版を取り出せないため）
  - 投入時の設定確認: nginx を作り直す前に `docker compose run --rm --no-deps nginx nginx -t` を通す。nginx の作り直し（`docker compose up -d nginx`）では 10 秒前後 Mattermost に届かなくなるため、日本時間 3 時台に行う
  - パッチの適用（必ず「投入前の退避」の後に行う。先に当てると `.pre-mcp` が変更後のコピーになり、切り戻しに使えない）: `/opt/mattermost-infra` で、本番 VM の 3 ファイルの `sha256sum` が `deploy/mattermost-infra.base/` の同じファイルと一致することを確かめ、`patch -p1 --dry-run` が通ってから `patch -p1` で当てる。一致しなければ当てずに差分を調べる
  - 切り戻し（`.pre-mcp` を基準にする）: `docker compose stop mcp`、退避したファイルを `cp` で書き戻し（設定はファイル単位の bind mount なので、`mv` やエディタの置き換えでは inode が変わりコンテナに反映されない）、`docker compose up -d nginx` で作り直す（ネットワークの変更は reload では外れない）
  - スナップショットからの復元: 設計書の「保存先」の 3 手順を、作業用 VM の作成、ディスクの接続とマウント、`docker build`、`docker run --rm --network none -v <マウント先>/srv/mcp:/data <イメージ> node src/admin.ts purge-credentials`、ディスクの切り離しまでのコマンドで書く
  - SQLite を失った場合: 同じ手順で直近のスナップショットから `/srv/mcp` を取り出す
  - Mattermost を更新するとき: ローカルで `MATTERMOST_IMAGE_TAG=<新しい版> npm run dev:up && MATTERMOST_IMAGE_TAG=<新しい版> npm run test:int` を通してから、本番の `mattermost-infra` の `compose/.env` を更新する。通らなければ更新を止める
  - 未認可の登録が上限に近い警告（`dcr_unauthorized_near_limit`）が出たときの確認方法（`list-clients --unauthorized`）
- [ ] **Step 2:** 利用者に、本番 Mattermost への OAuth アプリの作成と、本番 VM への反映の実施可否を確認する（実施日時、作成を利用者が System Console で行うか、作業者が管理者トークンで行うか）。確認が取れるまで Step 3 以降に進まない
- [ ] **Step 3:** 手順書どおりに本番へ投入し、各コマンドの結果を手順書の「本番投入の記録」に書く
- [ ] **Step 4: 本番での確認**
  - `curl -s https://mattermost.example.com/.well-known/oauth-authorization-server/mcp` と PRM が期待どおりの JSON を返す
  - 既存の Mattermost の利用（Web のログイン、投稿、WebSocket、Calls の接続）に変化がない
  - 作業者のアカウントで claude.ai のカスタムコネクタ、Claude Code、Codex CLI から接続し、読み取り系の 6 ツールを 1 回ずつ呼ぶ。`send_message` は作業者自身の DM にだけ投稿する
  - Mattermost の「設定 > セキュリティ > OAuth 2.0 アプリ」でアプリの許可を取り消し、次のツール呼び出しが「再ログインが必要」のエラーを返し、その次の要求でクライアントが再ログインを求めることを確かめてから、再ログインする
  - Cloud Logging の `syslog` に `tool_call` のログが届き、本文やトークンが含まれていない
