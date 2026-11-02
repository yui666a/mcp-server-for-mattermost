# mcp-server-for-mattermost

[English](README.md)

AI のクライアント（claude.ai、Claude Code、Codex CLI などの MCP クライアント）から、**利用者本人として** Mattermost を読み書きできるようにするリモート [MCP](https://modelcontextprotocol.io/) サーバー。
利用者は URL を 1 つコネクタとして追加し、自分の Mattermost のアカウントでログインする。
サーバーが見られるもの、できることは、その利用者の権限の範囲に限られる。

> ツールの説明、ツールの出力、同意画面、`docs/` 以下の文書は日本語で書いている。

## 何のためのものか

Mattermost は公式の MCP サーバーを [Mattermost Agents プラグイン](https://mattermost.com/blog/mattermost-mcp-server/)に含めて提供している。
その文書によると、Mattermost Server v12.0 以上が必要で、外部のクライアントがつなぐ HTTP エンドポイントを有効にするには Enterprise 以上のライセンスが要る。
ツールは約 120 個とはるかに多い。
そのライセンスと版があるなら、公式のものを使うのが自然である。

このプロジェクトは、それ以外の場合に向けたものである。

- **独立したサーバー**: 既存の Mattermost の横に 1 つのコンテナとして置き、プラグインを入れない。Mattermost とは REST API と OAuth 2.0 サービスプロバイダーだけでやり取りする
- **Team Edition で動く**: Mattermost Team Edition 11.7.8 で開発し、テストしている
- **利用者ごとの OAuth と、自前の認可サーバー**: MCP クライアントは自分を登録し（Dynamic Client Registration）、このサーバーでだけ使えるトークンを受け取る。利用者の Mattermost のトークンはサーバー側に暗号化して保存し、MCP クライアントには渡さない（token passthrough をしない）。認可のたびに、クライアントのリダイレクト URI を示す同意画面を出す
- **Team Edition でも予約投稿ができる**: Team Edition では Mattermost の予約投稿の API を使えないので、サーバーが予約を保存し、時刻が来たら本人のトークンで投稿する
- **LLM が呼ぶ前提の安全策**: クライアントがやり直したときの二重投稿を防ぐ。編集と削除は本人の投稿に限り、返信のあるスレッドの親投稿は消さない。下書きは、本文の違う既存の下書きを指示なしに上書きしない

## ツール

| ツール | 内容 |
|---|---|
| `search_posts` | 参加しているチームのメッセージを、Mattermost の検索構文（`from:`、`in:`、`before:` など）で検索する |
| `read_channel` | チャンネルの投稿を新しい順に読む |
| `read_thread` | スレッドの親投稿と返信を古い順に読む |
| `get_post` | post_id かパーマリンクの URL で 1 件の投稿を読む |
| `get_file` | 添付ファイルを読む。画像は縮小版を画像として返す |
| `search_channels` | 名前でチャンネル（公開、参加している非公開、DM、グループ DM）を探す |
| `list_my_channels` | 参加しているチャンネルを最終投稿の新しい順に一覧する |
| `get_channel` | チャンネルの種類、目的、ヘッダー、メンバー数、ピン留めされた投稿を読む |
| `get_unreads` | 未読のあるチャンネルと、スレッドの折りたたみが有効なら未読のスレッドを一覧する |
| `get_mentions` | 自分へのメンションを一覧する |
| `search_users` | 名前やユーザー名でユーザーを探す |
| `get_user` | ユーザーのプロフィールを、タイムゾーン、現地時刻、在席状況とともに読む |
| `send_message` | チャンネルやスレッドへ投稿する。小さなファイルと、`prepare_upload` でアップロードしたファイルを添付できる |
| `prepare_upload` | PC のファイル（スクリーンショット、PDF、写真など）を `curl` で送るための使い捨ての URL を発行する。Claude Code や Codex CLI のように PC でコマンドを実行できるクライアント向け |
| `add_reaction` / `remove_reaction` | 自分のリアクションを付ける、外す |
| `edit_message` / `delete_message` | 自分の投稿を編集する、削除する |
| `save_draft` | 本人が画面から送る Mattermost の下書きとして保存する |
| `schedule_message` | 投稿を予約する（1 分後から 30 日後まで） |
| `list_scheduled_messages` | 自分の予約を、状態とパーマリンクとともに一覧する |
| `update_scheduled_message` / `cancel_scheduled_message` | 待機中の予約を変える、取り消す |

時刻は JST で扱う。`schedule_message` の時刻（`YYYY-MM-DDTHH:mm[:ss[.sss]]`）はオフセットが無ければ `+09:00` として読むので、ほかのタイムゾーンなら `Z` か `+hh:mm`（`-hh:mm`）を付ける。検索の日付（`on:`、`before:`、`after:`）は JST の日として扱い、出力の時刻は UTC と JST を併記する。

読み取り系のツールには MCP の `readOnlyHint` を付けており、クライアントは書き込みの前に利用者へ確認を求められる。

## 構成

```text
MCP クライアント ──(MCP のトークン)──> mcp-server-for-mattermost ──(本人の Mattermost のトークン)──> Mattermost REST API
       │                                     │
       └─ ログイン: /mcp/oauth/authorize ─> 同意画面 ─> Mattermost の /oauth/authorize（ログイン）
```

- `<PUBLIC_URL>/mcp` で Streamable HTTP を提供する。セッションを持たず、POST だけを受ける
- OAuth のメタデータは `/.well-known/oauth-protected-resource/mcp` と `/.well-known/oauth-authorization-server/mcp`（パスを挟んだ形なので、Mattermost 自身のメタデータと同じオリジンに置ける）
- Mattermost に confidential な OAuth アプリを 1 つ登録する。1 プロセスで動き、状態は SQLite ファイルに持つ
- Mattermost API の呼び出しに、利用者ごとと全体の上限（毎分 300 回と 600 回）、タイムアウト、同時実行数の上限を設けている

設計の全体は [docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md](docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md) にある。

## 必要なもの

- OAuth 2.0 サービスプロバイダーを有効にした Mattermost。Team Edition 11.7.8 で確かめている。ほかの版は結合テストを通してから使う
- 開発には Node.js 26 以上と pnpm 11（`packageManager` で固定）。サーバーとローカルの Mattermost を動かすには Docker
- サーバーの HTTPS のオリジンと、その前に置くリバースプロキシ

## ローカルで試す

```bash
pnpm install
pnpm dev:up    # http://localhost:8065 で Mattermost 11.7.8 を起動し、dev/.state.json を書く
```

`pnpm dev:up` は、ユーザー `admin`、`alice`、`bob`（パスワード `Passw0rd!dev123`）、2 つのチーム、負荷の確認に使う `load1`〜`load6`、コールバックが `http://localhost:3000/mcp/oauth/callback` の OAuth アプリを作る。
ほかの版の Mattermost を試すときは `MATTERMOST_IMAGE_TAG` を指定する。

このローカルの Mattermost に向けてサーバーを起動する。

```bash
export PUBLIC_URL=http://localhost:3000 MM_URL=http://localhost:8065
export MM_OAUTH_CLIENT_ID=$(node -p "require('./dev/.state.json').oauth.clientId")
export MM_OAUTH_CLIENT_SECRET=$(node -p "require('./dev/.state.json').oauth.clientSecret")
export TOKEN_ENC_KEY=$(openssl rand -base64 32) DB_PATH=/tmp/mcp-dev.sqlite
pnpm start
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
```

同意画面のクッキーは `__Host-` で始まる名前に `Secure` を付けている。
実際の MCP クライアントからログインするには、サーバーを HTTPS のトンネルの後ろに置いて `PUBLIC_URL` をトンネルのオリジンにし、`node dev/setup.ts --callback https://<トンネル>/mcp/oauth/callback` で OAuth アプリのコールバックをそこに向ける。

テスト:

```bash
pnpm test        # 単体テスト
pnpm typecheck
pnpm test:int    # ローカルの Mattermost に対する結合テスト（先に pnpm dev:up）
pnpm dev:down    # ローカルの Mattermost を止め、データを消す
```

## 導入

確かめておく Mattermost の設定、OAuth アプリの作り方、環境変数、`compose.yml` の例、リバースプロキシに求めることと nginx の例は [docs/deployment.md](docs/deployment.md) にある。
サーバーは Mattermost と同じオリジン（`/mcp` 以下）にも、別のホストにも置ける。

## クライアントからつなぐ

URL は `<PUBLIC_URL>/mcp`（例 `https://mcp.example.com/mcp`）。

- **Claude Code**: `claude mcp add --transport http mattermost https://mcp.example.com/mcp` の後、`/mcp` からログインする
- **claude.ai**: この URL でカスタムコネクタを追加する
- **Codex CLI**: `codex mcp add mattermost --url https://mcp.example.com/mcp` の後、`codex mcp login mattermost`

クライアントごとの実測の挙動は [docs/measurements.md](docs/measurements.md) にある。

## 文書

- [docs/deployment.md](docs/deployment.md): 自分の環境への導入
- [docs/operations.md](docs/operations.md): 導入後の確認、ログ、管理コマンド、Mattermost とこのサーバーの更新、バックアップと復元、障害対応
- [docs/measurements.md](docs/measurements.md): Mattermost の OAuth の実測、クライアント互換性、負荷
- [docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md](docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md): 設計

## ライセンス

[MIT](LICENSE)

Mattermost is a trademark of Mattermost, Inc. This project is not affiliated with, sponsored by, or endorsed by Mattermost, Inc.
