# Mattermost リモート MCP サーバー 設計

## 目的

Claude（claude.ai とデスクトップ版）、Claude Code、Codex から、Slack Connector と同じ感覚で `mattermost.example.com` のメッセージを読み書きできるようにする。
利用者は URL `https://mattermost.example.com/mcp` をコネクタとして追加し、Mattermost のアカウントでログインするだけで使い始められる。

Mattermost は無償の Team Edition で、公式 Agents プラグインの外部 MCP エンドポイントのような有償版限定の機能は使えない。
そのため、自前の MCP サーバーを既存の Docker Compose 構成に追加する。

## ゴール

- claude.ai のカスタムコネクタ、Claude Code（`claude mcp add --transport http`）、Codex CLI の 3 つから、URL を登録して OAuth ログインするだけで接続できる
- 各利用者は自分の Mattermost アカウントの権限で動く。本人が見られないチャンネルやメッセージは MCP からも見えない
- 次の操作ができる
  - メッセージの検索
  - チャンネルの最新メッセージとスレッドの読み取り
  - パーマリンクの URL か post_id を指定した、1 件の投稿の読み取り
  - チャンネルとユーザーの検索、ユーザーのプロフィール参照
  - ユーザーのタイムゾーンと現地時刻、在席状況の参照
  - 参加しているチャンネルの一覧
  - チャンネルの種類、目的、ヘッダー、メンバー数、ピン留めされた投稿の参照
  - 自分の未読（チャンネルとスレッド）と、自分へのメンションの一覧
  - チャンネルやスレッドへの投稿
  - 投稿への自分のリアクションの追加と削除
  - 自分の投稿の編集と削除
  - 本人の Mattermost の下書きとしての保存（送信は本人が画面で行う）
- 一度ログインすれば、使い続けている限り、利用者が取り消すまで再ログインなしで使える（リフレッシュトークンで更新する）

## 非ゴール

- 他人の投稿の編集・削除、ファイルの添付、チャンネルの作成やメンバー管理
- システム管理系の操作（ユーザー管理、設定変更）
- Mattermost のイベントを MCP クライアントへ通知する機能（購読、通知）
- 複数の Mattermost サーバーへの対応

## 避けたいこと

- MCP サーバーを経由して、本人以外の権限で Mattermost が操作されること
- 利用者が意図しない MCP クライアントに、本人の Mattermost の権限が渡ること
- 意図しないチャンネルへの投稿
- Mattermost 本体の停止や性能劣化。MCP サーバーの障害や過負荷を Mattermost の利用に波及させない
- Mattermost のアクセストークンやメッセージ本文がログに残ること

## 前提（2026-11-01 時点で確認済み）

| 項目 | 値 |
|---|---|
| Mattermost | v11.7.8 Team Edition。VM `mattermost-vm`（e2-medium）の Docker Compose（リポジトリ `mattermost-infra` の `compose/docker-compose.yml`）で稼働 |
| リバースプロキシ | 同じ Compose の nginx 1.28（`mattermost-infra` の `nginx/mattermost.conf`）。TLS 終端は nginx |
| ログ収集 | Cloud Ops Agent は既定設定で、journald から `/var/log/syslog` に流れた分を Cloud Logging に送っている。Docker 既定の json-file ドライバーのコンテナ出力は届かない |
| OAuth 2.0 Service Provider | 有効。`/.well-known/oauth-authorization-server` を公開しており、`registration_endpoint` はない（Dynamic Client Registration は無効） |
| Mattermost の OAuth | 認可コードフロー、PKCE は `S256` のみ。public client にはリフレッシュトークンが発行されず、confidential client（`client_secret_post`）には発行される。スコープは `user` のみ |
| Mattermost のトークン再利用 | 同じユーザーと同じ OAuth アプリの組では、新たに認可しても既存のアクセストークンとリフレッシュトークンが返る。リフレッシュするとリフレッシュトークンは新しいものに替わり、使用済みのものは使えなくなる。古いアクセストークンは、ローカルの v11.7.8 での実測ではリフレッシュ後も少なくとも 826 秒は有効なまま残り、利用者がアプリの許可を取り消すと無効になった（[v11.7.8 `oauth.go`](https://github.com/mattermost/mattermost/blob/v11.7.8/server/channels/app/oauth.go)、実測の詳細は `docs/runbook.md`）。Mattermost のトークンは MCP サーバーの外に出さないため、古いアクセストークンが残ることは設計に影響しない |
| 下書きの同期 | サーバー設定 `ServiceSettings.AllowSyncedDrafts`（既定 true）が有効なときだけ、API で保存した下書きが本人の画面に届く。無効なら下書きの API は 501 を返す。本番で有効かは、投入前に確かめる（`docs/runbook.md` の「事前確認」） |
| Mattermost の台数 | 1 台構成で、下書きの一覧を読むレプリカを持たない。本番にレプリカが無いことは、投入前に確かめる（`docs/runbook.md` の「事前確認」） |
| 利用者 | 約 20 人、世界中から利用 |

## 構成

### 方式: MCP サーバーが自分の認可サーバーを持ち、ログインを Mattermost に委ねる

MCP 仕様（2025-06-18 以降）では、MCP サーバーは自分宛てに発行されたトークンだけを受け付けなければならず、受け取ったトークンを下流の API にそのまま渡すこと（token passthrough）は禁止されている。
Mattermost v11.7.8 には RFC 8707 の `resource` を受け取って記録する実装があるが、REST API がトークンの宛先（audience）を検証することは確認できていない。
Mattermost のトークンを MCP クライアントに直接持たせると、その MCP クライアントが Mattermost の全 API を本人として叩ける。

そこで、MCP サーバーは次の 2 つの役割を持つ。

1. **MCP クライアントに対する認可サーバー**: MCP クライアントの登録（Dynamic Client Registration）、認可、トークン発行を自分で行う。発行するトークンは MCP サーバー宛てで、Mattermost の API には使えない
2. **Mattermost に対する OAuth クライアント**: Mattermost に confidential client として 1 つだけ登録し、利用者のログインを Mattermost の認可画面に任せる。得た Mattermost のトークンはサーバー側に暗号化して保存し、MCP クライアントには渡さない

```text
MCP クライアント ──(MCP トークン)──> MCP サーバー ──(Mattermost トークン)──> Mattermost API
       │                                   │
       └─ 認可: MCP サーバーの /authorize ──> 同意画面 ──> Mattermost の /oauth/authorize（ログイン）
```

### URL とメタデータ

ドメイン直下の `/.well-known/oauth-authorization-server` は Mattermost 自身のメタデータが使っているため、MCP サーバーの認可サーバーは issuer にパスを含め、RFC 8414 のパス挿入形式でメタデータを公開する。

| 項目 | 値 |
|---|---|
| MCP エンドポイント（リソース） | `https://mattermost.example.com/mcp`（末尾スラッシュなし） |
| Protected Resource Metadata（RFC 9728） | `https://mattermost.example.com/.well-known/oauth-protected-resource/mcp` |
| 認可サーバーの issuer | `https://mattermost.example.com/mcp` |
| Authorization Server Metadata | `https://mattermost.example.com/.well-known/oauth-authorization-server/mcp` |
| 認可、トークン、登録、Mattermost からのコールバックなどのエンドポイント | `https://mattermost.example.com/mcp/oauth/` 以下。具体的なパスは実装者が決める |

メタデータには次を必ず含める。

- Protected Resource Metadata: `resource` は MCP エンドポイントの URL と完全一致させる（claude.ai はパスまで完全一致を要求する）。`authorization_servers` は issuer 1 つだけ
- Authorization Server Metadata: `issuer`、`authorization_endpoint`、`token_endpoint`、`registration_endpoint`、`response_types_supported: ["code"]`、`grant_types_supported: ["authorization_code", "refresh_token"]`、`code_challenge_methods_supported: ["S256"]`、`token_endpoint_auth_methods_supported: ["none"]`（DCR で登録されるクライアントは public client とする）、`scopes_supported: ["mattermost"]`
- Protected Resource Metadata にも `scopes_supported: ["mattermost"]` を載せ、`401` の `WWW-Authenticate` にも `scope="mattermost"` を付ける

スコープは `mattermost` の 1 つだけとし、「この利用者の Mattermost アカウントとしてツールを使う」ことを表す。
読み取りと書き込みを利用者ごとに分けて許可する要望はないため、ツールの数に依らず、読み取りと書き込みでスコープを分けない。

- 認可要求で `scope` が省略されたときは `mattermost` を与える。`mattermost` 以外のスコープが含まれていれば `invalid_scope` で拒否する
- スコープは認可コード、grant、アクセストークン、リフレッシュトークンに結び付け、リフレッシュで広げられないようにする

認可要求とトークン要求の `resource` パラメータは必須とし、欠落しているか MCP エンドポイントの URL と完全一致しなければ `invalid_target` で拒否する。
発行した認可コードとトークンは、この 1 つのリソースにだけ使える。
早期接続確認で対象クライアントのどれかが `resource` を送らないと分かった場合は、この設計の変更として利用者に相談する。

この形式は RFC 8414 と MCP 仕様の探索手順に沿っており、3 つのクライアントの公式資料も DCR と Streamable HTTP への対応を明記している。
ただし実クライアントでの動作は未確認なので、実装の早い段階で 3 つのクライアントすべてから接続できることを確かめる。
どれかが探索に失敗し、MCP サーバー側の工夫で回避できない場合は、サブドメイン（例 `mcp.example.com`）へ移すことを利用者に相談する。

### 認可フロー

1. MCP クライアントが `/mcp` にトークンなしでアクセスすると、MCP サーバーは `401` と `WWW-Authenticate: Bearer resource_metadata="…"` を返す
2. MCP クライアントは Protected Resource Metadata から認可サーバーを知り、Authorization Server Metadata を取得する
3. MCP クライアントは DCR（RFC 7591）で自分を登録する
4. MCP クライアントが PKCE（`S256` 必須）付きで MCP サーバーの認可エンドポイントへ利用者を送る。MCP サーバーは `client_id`、`redirect_uri`、PKCE、`resource` を検証する
5. MCP サーバーは同意画面を出す
6. 利用者が許可すると、MCP サーバーは Mattermost の `/oauth/authorize` へリダイレクトする。このとき MCP サーバーから Mattermost への認可にも、MCP クライアントとは別に生成した PKCE（`S256`）を付ける
7. 利用者は Mattermost でログインし、許可する
8. Mattermost からコールバックに戻ると、MCP サーバーは `state` を照合し、Mattermost のトークンを取得して保存し、MCP クライアントへ認可コードを返す
9. MCP クライアントは認可コードを MCP サーバーのトークンエンドポイントで MCP トークン（アクセストークンとリフレッシュトークン）に交換する

### MCP クライアントへ発行する認可コード

OAuth 2.1 の認可コードの要件（draft-13 §4.1.2–4.1.3）を満たすため、次を守る。

- 認可コードは十分な長さのランダム値とし、サーバー側にはハッシュだけを保存する。有効期限は 1 分程度とする
- 認可コードには、Mattermost ユーザー、`client_id`、認可要求の `redirect_uri`、PKCE の `code_challenge`（`S256`）、`resource` を結び付けて保存する
- トークン要求では、`client_id`、`redirect_uri` が保存した値と一致すること、`code_verifier` が `code_challenge` と一致することをすべて確かめる。1 つでも合わなければ `invalid_grant` で拒否する。`resource` の欠落や不一致は `invalid_target` で拒否する
- 認可コードの消費とトークンの発行は 1 つのトランザクションで行い、同じコードを 2 回使えないようにする。使用済みのコードが再び提示されたら、そのコードから発行したトークンを失効させる
- MCP クライアントから受け取った `state` は、Mattermost へ送る `state` とは別に保存し、成功時もエラー時もそのままの値で MCP クライアントへ返す

### 同意画面

Mattermost 側の OAuth アプリは 1 つの固定クライアント ID で、誰でも DCR でクライアントを登録できる。
同意画面がないと、「攻撃者が登録したクライアントのリダイレクト先へ、Mattermost にログイン済みの利用者の認可が自動で流れる」confused deputy 攻撃が成立する。
MCP の Security Best Practices に従い、同意画面は次を満たす。

- 認可要求のたびに、Mattermost へリダイレクトする前に必ず表示する。同意の記憶による省略はしない。利用者が認可するのはクライアントを追加するときだけで、毎回の表示は負担にならないため
- クライアント名、登録されたリダイレクト URI の全体、要求されている権限（スコープ `mattermost` の意味として「あなたの Mattermost アカウントとしてメッセージの読み書きをする」）を表示する。クライアント名は登録者が自由に付けられるため、リダイレクト URI を名前より目立たせる
- リダイレクト URI がループバック（`localhost`、`127.0.0.1`）のクライアントには、「この端末上のアプリに権限を渡す。自分で Claude Code や Codex の接続を始めた場合だけ許可する」旨の警告を追加で表示する（MCP 2025-11-25 の Localhost Redirect URI Risks）
- 許可フォームには CSRF トークンを付ける。応答に `Content-Security-Policy: frame-ancestors 'none'` と `X-Frame-Options: DENY` を付け、他サイトの iframe に埋め込ませない
- Mattermost へ送る `state` は、利用者が許可した時点で生成する。サーバー側の認可途中の記録に、ブラウザのクッキー、Mattermost へ送る `state` と PKCE、MCP クライアントの `client_id`、`redirect_uri`、PKCE、`state`、`resource` をまとめて保存する。この記録は 1 回だけ使えて、10 分程度で期限切れにする。コールバックで `state` とクッキーが記録と一致しなければ拒否する
- DCR で登録されたクライアント名とリダイレクト URI は、登録者が自由に決めた信用できない値として扱う
  - 登録時に長さの上限を設け、制御文字を含む値を拒否する
  - 同意画面とエラーページでは、自動でエスケープするテンプレートかテキストノードとしてだけ表示し、HTML として解釈させない
  - DCR の `logo_uri` などの外部リソースは読み込まない
  - クライアント名の横に「名前は登録者の自己申告で、確認されていない」と表示する
- 同意画面とエラーページの応答には `Content-Security-Policy: default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` 相当を付け、スクリプトを一切実行させない。同意画面はスクリプトなしで動く HTML フォームとする
- 悪意あるクライアント名やリダイレクト URI（HTML タグ、制御文字、極端に長い値）で登録し、同意画面でスクリプトが実行されず表示も崩れないことを自動テストで確かめる
- クッキーは `__Host-` で始まる名前にし、`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` を付け、`Domain` は付けない（MCP Security Best Practices の Confused Deputy 対策）。値はランダムなセッション ID とし、中身はサーバー側に持つ

### リダイレクト URI

DCR で登録を受け付けるリダイレクト URI は次に限る。
これに当てはまらない登録要求は `invalid_redirect_uri` で拒否する。

- `https://claude.ai/api/mcp/auth_callback`、`https://claude.com/api/mcp/auth_callback`（claude.ai とデスクトップ版。現行の [Authentication for connectors](https://claude.com/docs/connectors/building/authentication#callback-urls) が指定するのは `claude.ai` 側だけだが、Anthropic の旧ヘルプセンター記事（現在は公開終了）が、将来 `claude.com` 側に変わる可能性があるとして両方の許可を勧めていた。Anthropic 管理のドメインを完全一致で 1 つ足すだけなので両方を許可する）
- ループバック（`http://localhost:<任意ポート>/<任意パス>`、`http://127.0.0.1:<任意ポート>/<任意パス>`）（Claude Code、Codex CLI）

許可パターンは環境変数で追加できるようにする。

認可要求の `redirect_uri` は、その `client_id` に登録された URI と完全一致させる。
例外はループバックのポート番号だけで（RFC 8252、RFC 9700）、スキーム、ホスト、パス、クエリは一致させる。
`client_id` が不明な場合や `redirect_uri` が一致しない場合は、エラーをリダイレクトで返さず、MCP サーバー自身のエラーページを表示する。

### MCP のトークン

- アクセストークンは短命（1 時間程度）とする。リフレッシュトークンの期限は最後に使われてから 90 日程度とし、ローテーションのたびに期限を延ばす。発行からの絶対期限は設けない。使い続けている限り再ログインは要らず、90 日使わなかった利用者だけが再ログインする。正確な値は実装者が決める
- トークンはランダムな不透明文字列とし、サーバー側にはハッシュだけを保存する
- リフレッシュトークンはローテーションする（RFC 9700 §4.14.2）。1 回の認可から続くトークンの系列（grant）を記録し、リフレッシュでは使用済みの記録と新しいトークンの発行を 1 つのトランザクションで行う。使用済みのリフレッシュトークンが再び提示されたら、盗まれたものとみなし、その grant のアクセストークンとリフレッシュトークンをすべて失効させる
- 利用者が Mattermost の「設定 > セキュリティ > OAuth 2.0 アプリ」から MCP サーバーのアプリを取り消すと、後述の流れでその利用者の grant がすべて失効する

### Mattermost のトークン

Mattermost は同じユーザーと同じアプリの組に 1 組のトークンしか持たせないため、Mattermost のトークンは Mattermost ユーザーごとに 1 組だけ保存し、その利用者のすべての grant から参照する。
MCP クライアントごとに複製して持つと、どれか 1 つがリフレッシュした時点で他の複製が無効になる。

- アクセストークンとリフレッシュトークンは、環境変数で渡す鍵で暗号化して保存する。鍵を変えると保存済みのトークンが読めなくなり、全員が再ログインする
- Mattermost の API が `401` を返したら、まず保存済みの最新のトークンを読み直す。別の要求が既にリフレッシュしていれば、そのトークンで 1 回だけ再試行する
- リフレッシュはユーザー単位で 1 つずつ行う（同時に来た要求は 1 回のリフレッシュの結果を待つ）。新しいアクセストークンとリフレッシュトークンは 1 つのトランザクションで書き換える
- リフレッシュに対して Mattermost が `invalid_grant` を返したとき、または利用者が無効化されたときだけ、その利用者の Mattermost のトークンと MCP の grant をすべて失効させ、MCP クライアントに `401` を返して再ログインを促す
- タイムアウト、接続失敗、`5xx` などの一時的な失敗では保存した情報を変えず、ツールの一時的なエラーとして返す

### 保存先

1 台の VM で 1 プロセスだけ動かすので、保存先は Compose のボリュームに置く SQLite ファイルとする。
保存するのは、登録された MCP クライアント、認可途中の状態、MCP の grant とトークン、Mattermost のトークン、`send_message` の重複防止の記録である。

このうち DCR の登録は、各クライアントが接続ごとに 1 回だけ行い、得た `client_id` を使い続ける。
登録が消えると、そのクライアントは `invalid_client` になり、再ログインでは戻らない（コネクタの削除と追加し直しが要る）。
一方、DCR の登録エンドポイントは認証なしで公開されるため、第三者が登録を積み上げられる。
そこで登録を 2 つに分けて扱う。

- **認可済みの登録**（一度でも利用者が認可を完了した登録）: 自動では消さない。認可には Mattermost のアカウントが要るため第三者には増やせず、総数の上限も設けない
- **未認可の登録**: 専用の上限（数百件程度）と期限（7 日程度）を設ける。期限を過ぎたものは消す。上限に達したら、新しい登録を拒否せず、最も古い未認可の登録を消して枠を空ける。第三者が登録を積み上げても、正規の利用者が新しく接続できなくなることはない
- 未認可の登録を消されたクライアントは、認可を始めた後に 7 日以上放置した場合などに限られ、そのときはコネクタを追加し直す
- 登録エンドポイントには IP ごとのレート制限もかける（「Mattermost への影響を抑える仕組み」）。未認可の登録が上限に近づいたら警告ログを出す

MCP サーバー専用のバックアップは取らない。
SQLite ファイルを失った場合は、次の「スナップショットからの復元」と同じ手順で、直近のスナップショットから SQLite ファイルだけを取り出して DCR の登録を戻す。
スナップショットより後に登録したクライアントは戻らないので、その利用者にはコネクタを追加し直してもらう。

ただし SQLite ファイルと暗号化鍵（`compose/.env`）は VM のブートディスク上にあり、既存の日次ディスクスナップショットに含まれる。
古いスナップショットから復元すると、使用済みのリフレッシュトークンの記録や失効した grant が過去の状態に戻り、ローテーション済みの古いトークンが再び有効になりうる。
そこで、スナップショットからの復元は次の手順に限る。

1. 復元したディスクを起動ディスクとして使う前に、作業用の VM にデータディスクとして接続する。復元したディスクから直接起動すると、Compose のコンテナが `restart: unless-stopped` で自動起動し、外部 IP がなくても同じ VPC の内部（`default-allow-internal`）からは巻き戻った状態の MCP サーバーに到達できるため
2. 作業用の VM で、復元したディスク上の `/opt/mattermost-mcp` から MCP サーバーのイメージをビルドし（イメージはレジストリに置いていないため）、その管理コマンドをネットワークなしで実行し（SQLite の `-wal`、`-shm` を含めてディレクトリごとマウントする）（`docker run --rm --network none -v <SQLite のディレクトリ>:/data <イメージ> <削除コマンド>`）、認可途中の状態、認可コード、grant、MCP のトークン、Mattermost のトークン、`send_message` の重複防止の記録をすべて削除する。登録された MCP クライアント（DCR の登録）は消さない
3. ディスクを作業用の VM から外し、そのディスクから VM を起動する

DCR の登録を残すので、各クライアントはコネクタを追加し直す必要がなく、手元のリフレッシュトークンが `invalid_grant` で拒否された後の通常の再ログインだけで戻る。
DCR の登録は利用者の権限を持たないため、巻き戻っても実害はない。
暗号化鍵は作り直さない。Mattermost のトークンを削除するので、古い鍵で暗号化された値は残らない。
この手順を運用手順書に書く。

既存の PostgreSQL に DB を追加する方式は採らない。
Mattermost の DB と運用（ダンプ、リストア、メジャーバージョン更新）を共有することになり、MCP サーバーの都合で Mattermost の DB に手を入れる場面を作りたくないからだ。

### MCP の転送方式

Streamable HTTP を `/mcp` で提供する。
セッションを持たない stateless モードとし、通知の購読は提供しない。
旧方式の HTTP+SSE は提供しない（3 つの対象クライアントはいずれも Streamable HTTP に対応している）。

MCP の Streamable HTTP の仕様に従い、`Origin` ヘッダーがある要求は許可リスト（既定は `https://claude.ai` と `https://claude.com`、環境変数で追加可）に含まれなければ `403` で拒否する。
`Origin` ヘッダーのない要求（CLI やサーバー間の通信）は、ベアラートークンの検証だけで受け付ける。

### ツール

すべて呼び出した利用者の Mattermost トークンで Mattermost REST API v4 を呼ぶ。
MCP サーバー自身は管理者トークンや Bot アカウントを持たない。

| ツール | 内容 |
|---|---|
| `search_posts` | 利用者が参加しているチームを対象にメッセージを検索する。Mattermost の検索構文（`from:`、`in:`、`before:`、`after:` など）をそのまま渡せる |
| `read_channel` | チャンネルの最新メッセージを新しい順に、件数を指定して読む。ページングできる |
| `read_thread` | スレッドの親投稿と返信を古い順に読む。ページングできる |
| `get_post` | パーマリンクの URL か post_id で指定した 1 件の投稿を、チャンネルとチーム、返信数とともに読む。返信なら親の post_id を、返信のある親投稿なら `read_thread` で続きを読めることを示す |
| `search_channels` | 名前でチャンネルを探す（公開チャンネルと、利用者が参加している非公開チャンネル、DM、グループ DM） |
| `list_my_channels` | 参加しているチャンネル（公開、非公開、DM、グループ DM）を、最終投稿の新しい順に一覧する。種類で絞れる。アーカイブ済みは含まない |
| `get_channel` | チャンネルの種類、目的、ヘッダー、メンバー数、ピン留めされた投稿を読む。メンバーの一覧は返さない |
| `search_users` | 名前やユーザー名でユーザーを探す |
| `get_user` | ユーザーのプロフィールに、タイムゾーンと呼び出した時点の現地時刻、在席状況（オンライン、離席、取り込み中、オフライン、不在）を添えて読む |
| `get_unreads` | 未読のあるチャンネル（未読数、メンション数）と、スレッドの折りたたみ（CRT）が有効なら未読の返信があるスレッドを一覧する。既読にはしない |
| `get_mentions` | 自分へのメンション（`@ユーザー名` と通知の設定のキーワード）を新しい順に一覧する。全チームと DM が対象 |
| `send_message` | チャンネルへ投稿する。`root_id` を渡すとスレッドへの返信になる |
| `add_reaction` | 投稿に自分のリアクションを付ける。絵文字は Mattermost の絵文字名で指定し、前後のコロンは外して受け付ける。別名（`thumbsup` と `+1` など）はまとめない。Mattermost 自体が別のリアクションとして扱うため |
| `remove_reaction` | 投稿から自分のリアクションを外す。他人のリアクションは外さない。Mattermost は付いていないリアクションでも成功を返すため、外したかどうかは区別しない |
| `edit_message` | 自分の投稿の本文を書き換える。編集で足したメンションは通知されない（Mattermost が編集では通知しないため） |
| `delete_message` | 自分の投稿を削除する。削除は取り消せないので、ツールの説明で、実行の前に利用者へ確認するよう MCP クライアントに求める |
| `save_draft` | 投稿せずに、本人の下書きとして保存する。`root_id` を渡すとスレッドへの返信の下書きになる。同じ投稿先に本文の違う下書きがあれば、`overwrite` を指定しない限り上書きしない |

- 読み取り系のツールには MCP のツール注釈 `readOnlyHint: true` を付け、書き込み系のツール（`send_message`、`add_reaction`、`remove_reaction`、`edit_message`、`delete_message`、`save_draft`）には付けない。MCP クライアントが書き込みの前に利用者へ確認を求められるようにするため
- 出力は LLM が読みやすいテキストとし、投稿ごとに投稿者のユーザー名、日時、本文、パーマリンク（`https://mattermost.example.com/<team>/pl/<post_id>`）を含める。読み取り系の出力には、チャンネルとチームの ID と名前も含め、LLM が続く呼び出しで ID を使えるようにする
- チャンネルの指定は次のどれかとする。名前から候補が 2 つ以上見つかった場合は、どれかを選ばずにエラーとし、候補のチーム名、チャンネル名、チャンネル ID を返す
  - チャンネル ID
  - `チーム名/チャンネル名`
  - チャンネル名だけ（利用者が参加しているチームから探す）
  - `@ユーザー名`（その相手との DM）
- `send_message` は、チャンネル ID 以外の指定で投稿先が一意に決まらない場合、必ずエラーにする。`root_id` を渡したときは、その投稿が指定したチャンネルにあることを確かめる
- ユーザーはユーザー ID か `@ユーザー名` で指定する
- `get_post` が受け付ける URL は、Mattermost の URL（`MM_BROWSER_URL`）とオリジンとベースのパスが一致し、userinfo を含まない `…/<チーム名>/pl/<post_id>` の形だけとする。ほかのホストのパーマリンクの post_id を、この Mattermost の投稿として読み違えないため。URL のチーム名は使わず、出力のパーマリンクは投稿の実際のチームで作る
- 1 回の応答が大きくなりすぎないよう、件数と本文の長さに上限を設ける。具体的な値は実装者が決める
- 件数が上限を超えうるツール（`search_posts`、`read_channel`、`read_thread`、`search_channels`、`search_users`、`list_my_channels`、`get_channel` のピン留め、`get_unreads`、`get_mentions`）は、入力に `limit` と `cursor` を取り、出力に続きがあるかどうかと次の `cursor` を含める。続きがあるのに黙って切り捨てない。本文を長さの上限で切った場合も、切ったことを出力に明示する
- `read_channel` は新しい順、`read_thread` は古い順に返す。`read_thread` の親投稿は最初のページにだけ含める
- `list_my_channels` の件数は既定 50、最大 200 とする。並びは `last_post_at` の新しい順（同じなら `channel_id` の順）で、ページの合間に投稿があると順序が変わる。そこで 2 ページ目以降は、最初のページの時点より後に更新されたチャンネルを本体から除き、前のページの後に更新されたチャンネルを本体の前の節にまとめて出す。こうすると、ページの合間に投稿があって前へ動いたチャンネルも抜けない。ただし、ページの合間に参加したチャンネルのように、更新時刻が進まないまま前の位置に入った行は出ないことがある。この節がページに収まらないときは、`next_cursor` を出さずに最初のページから取り直すよう促す
- `get_channel` のピン留めの件数は既定 10、最大 50 とする。Mattermost の `/channels/{id}/pinned` には件数の上限もページングもないため、全件を取って `create_at` の新しい順（同じなら post_id の順）に並べ、最後に出した投稿の `create_at` と post_id をカーソルに入れる。カーソルを渡されたときは、ピン留めの続きだけを出す。ページの合間にカーソルより古い投稿がピン留めされると、その投稿は出ない
- `get_channel` は、チャンネルを取る API の 403 と 404 を、権限がない旨とチャンネルが見つからない旨の文言に変える。参加していない公開チャンネルでは Mattermost がメンバー数を返さない（`/stats` が 403）ため、メンバー数だけを取得できない旨にして、ほかの項目は返す
- `get_user` のタイムゾーンは、自動設定なら自動判定の値を使い、自動か手動かを添える。空か不正な値なら未設定とし、現地時刻は出さない。在席状況が取り込み中で終了時刻があるときは、その時刻を UTC と JST で添える。在席状況の取得で Mattermost がエラーを返したら、在席状況だけを取得できない旨にしてプロフィールは返す
- `get_unreads` の件数は既定 30、最大 100 とし、チャンネルとスレッドを合わせて数える。CRT が利用者に効いているかは、サーバー設定 `CollapsedThreads` と、`default_on`／`default_off` のときだけ利用者の設定で決め、出力の先頭に書く。CRT が有効ならチャンネルの未読はルート投稿だけで数え、返信は未読のスレッドとして出す。通知を「メンションのみ」にしたチャンネルは、メンションがあるときだけ出す。スレッドの一覧はアーカイブ済みチャンネルのスレッドも返すが、チャンネルの節と基準をそろえるため、参加しているチャンネルの一覧（アーカイブ済みを含まない）に無いチャンネルのスレッドは除き、件数にも数えない。並びはチャンネル（メンションのあるものが先、その中で更新の新しい順）の後にスレッド（最終返信の新しい順）で、ページ送りは `list_my_channels` と同じく、前のページの後に更新された行を本体の前の節に出す。ただし、投稿なしで未読やメンションの有無が変わった行（「未読にする」の操作など）や、ページの合間に参加したチャンネルは、出ないことがある。チャンネルの更新時刻は、CRT が有効なら最終のルート投稿、無効なら最終投稿とする。ページの合間に CRT の判定が変わると更新時刻の定義が入れ替わるため、カーソルに判定を入れ、食い違えば最初のページから取り直すよう促す。スレッドの一覧が 4xx を返したら、チャンネルの未読だけを返し、スレッドを取得できなかったことを書く
- `get_mentions` の件数は既定 20、最大 50 とする。Web の「最近のメンション」と同じ語で OR 検索し、database 検索が `@` の無い語にも当たるため、Mattermost のサーバーと同じ規則で本文を照合して、メンションでない投稿を落とす。Mattermost の database 検索は 100 件までしか返さず、`page > 0` では何も返さないので、100 件に達したら最も古い日を次の回に回し、`before:` を 1 日ずつ戻して検索し直す。1 日だけで 100 件を超えた日は、新しい 100 件だけを出し、そのことを書く
- `search_users` には在席状況を加えない。ユーザーごとに API の呼び出しが増えるうえ、一覧から相手を選んだあとに `get_user` を呼べば足りるため
- カーソルには件数と、`list_my_channels` の種類の絞り込みも入れ、カーソルを渡されたときは引数の側を無視する。ページの途中で母集団が変わらないようにするため

### `send_message` の二重投稿の防止

Mattermost が投稿を受け付けた後で MCP クライアントへの応答が切れると、クライアントや LLM は成否が分からないまま同じ呼び出しをやり直し、同じ投稿が 2 回できる。
やり直すのは LLM なので、LLM に重複防止のキーを生成させても、やり直しのときに同じキーを使う保証はない。
そこで MCP サーバー側で、同じ利用者が同じ投稿先（チャンネルと `root_id`）へ同じ本文を短い時間（10 分程度）のうちに投稿しようとしたら、同じ投稿のやり直しとみなす。

Mattermost v11.7.8 には、投稿の `pending_post_id` が同じ要求を 30 秒間まとめる重複排除がある（[`post.go` の `deduplicateCreatePost`](https://github.com/mattermost/mattermost/blob/v11.7.8/server/channels/app/post.go)。公開 API の文書には書かれていない）。
これだけでは 30 秒を過ぎたやり直しを防げないため、MCP サーバー側の記録と組み合わせる。

- 利用者、投稿先、本文のハッシュの組に一意制約を付けた記録を SQLite に置く。記録には、そのとき生成した `pending_post_id` と状態（投稿中、成功）を持たせる
- 投稿の前に記録を作る。同じ組の記録が既にあれば、新しい記録は作らない。Mattermost へは常に記録の `pending_post_id` を付けて投稿する
- 成功したら投稿 ID を記録する。Mattermost が明確に拒否したら（`4xx`）記録を消す
- 同じ組の「成功」の記録があれば、投稿せずに前回の投稿 ID とパーマリンクを返し、やり直しとして投稿しなかったことを出力に明示する
- 同じ組の「投稿中」の記録があり、作られてから Mattermost API のタイムアウト（数十秒）が過ぎていなければ、先の要求がまだ処理中とみなして投稿せず、「同じ投稿を処理中なので少し待って結果を確かめる」旨のエラーを返す
- タイムアウトを過ぎた「投稿中」の記録は、先の要求の結果が分からないまま終わったものとみなす。やり直す要求は、まず記録の更新時刻を原子的に書き換えて再試行の権利を取る（同時に来た要求のうち 1 つだけが取れ、取れなかった要求は前項と同じく処理中として扱う）。権利を取った要求は、そのチャンネル（と `root_id`）で記録の作成時刻以降にその利用者が投稿した、本文が完全に一致する投稿を Mattermost から探し、見つかればそれを成功として記録して返す。見つからなければ同じ `pending_post_id` で投稿する
  - `pending_post_id` は DB に保存されないため、探す条件には使えない。探すときは全文検索 API ではなく、時刻で絞ってチャンネルの投稿を取得する API（`GET /api/v4/channels/{id}/posts?since=`）を使う。全文検索の分かち書きやインデックスの遅れで、一致する投稿を見落とさないため
  - 「投稿中」を結果不明とみなすまでの猶予は、MCP 側の API タイムアウトに余裕を足した値にする。それでも Mattermost の処理が猶予より遅れて完了した場合の二重投稿は防げず、既知の限界とする
- 同じ本文を意図して繰り返し投稿したい場合のため、`send_message` に重複防止を外す引数（`allow_duplicate`）を設ける
- 自動テストで、Mattermost が投稿を受け付けた後に応答を切る障害、同じ投稿の同時要求、30 秒を過ぎてからのやり直しを起こし、二重投稿にならないことを確かめる。`pending_post_id` の重複排除は公開文書にない挙動なので、Mattermost を更新するときにもこのテストを通す

### 投稿の編集と削除

Mattermost の権限では、チーム管理者は他人の投稿を削除でき、システム管理者は編集もできる。MCP からは、本人の投稿だけを扱う。

- 先に投稿を読み、`user_id` が本人でないもの、`props.from_webhook` か `props.from_bot` が付いたもの、`type` が空でないもの（システムメッセージなど）は断る。受信 webhook の投稿は `user_id` が webhook の作成者になるため、`user_id` だけでは判定できない
- `props.from_oauth_app` は見ない。この MCP が `send_message` で作った投稿にも付くので、断ると AI の誤った投稿を直せなくなる
- 編集は `PUT /posts/{id}/patch` に本文だけを送る。`PUT /posts/{id}` は、省いた `is_pinned` を外すため使わない
- 返信のあるスレッドの親投稿は消さない。Mattermost は親を消すと他人の返信もまとめて消すため。親かどうかは `root_id` が空かで判定し、`reply_count` が数値で返らなければ返信があるものとして断る。返信の投稿にもスレッド全体の `reply_count` が載るので、`reply_count` だけでは判定できない
- 既知の限界
  - 返信の有無を確かめてから消すまでのあいだに付いた返信は、親と一緒に消える。Mattermost に条件付きの削除が無いため防げない
  - 返信のない親投稿を消しても、ほかの利用者のそのスレッドへの下書きは消える。Mattermost の削除の動作で、防ぐ手段は無い

### 下書きの保存

下書きは利用者・チャンネル・`root_id` の組ごとに 1 つで、保存は上書き（upsert）になる。本人の書きかけを消さないよう、保存の前に既存の下書きを確かめる。

- 既存の下書きの本文が違えば、`overwrite: true` が無い限り保存せず、既存の本文の先頭を添えて断る。本文が同じなら保存し直さない。上書きは添付ファイルと優先度も置き換え、取り消せないため、注釈は `destructiveHint: true` とする
- `root_id` は、同じチャンネルにある返信でない投稿であることを確かめる。Mattermost は存在しない投稿や返信の ID でも保存し、画面のどのスレッドにも出ない下書きが残るため
- 利用者が「設定 > 詳細設定」で下書きの同期を切っていたら（preference `advanced_settings/sync_drafts` が `false`）、保存せずに断る。同期を切った webapp は、閉じている間に保存された下書きを読み込まず、利用者の書きかけもブラウザの中にしか無いので、既存の下書きの確認では見えないため。preference が無いときは同期が有効として扱う
- 既知の限界
  - 既存の下書きを確かめてから保存するまでのあいだに、本人が画面で書いた下書きは上書きされうる
  - 保存したときにそのチャンネルを webapp で開いていると、開いている入力欄には反映されない。そのまま本人が書いてチャンネルを切り替えると、webapp がサーバーの下書きを上書きし、保存した下書きは警告なく失われる。webapp の動作なので防げず、出力で、開き直してから編集するよう添える
  - 返信の下書きが右側のパネルにどう出るかは確かめていない。そのため、返信の下書きの出力では入力欄に入っているとは言わない
  - Mattermost のサーバーは、投稿を作っても対応する下書きを消さない（下書きを消すのは webapp の送信の処理）。そのため、保存した下書きを `send_message` で送っても下書きは残り、本人がそれをそのまま送ると同じ投稿が 2 回になる。ツールの説明と出力でこのことを伝える

### Mattermost への影響を抑える仕組み

`mcp` コンテナは Mattermost と同じ VM（e2-medium）の CPU、メモリ、ディスクを共有する。
攻撃、不具合、メモリリーク、DB の肥大で Mattermost を巻き込まないよう、次を必須とする。

- `mcp` サービスに CPU、メモリ、プロセス数の上限を設ける（Compose の `cpus`、`mem_limit`、`pids_limit`）。具体値は実装者が決めるが、Mattermost と PostgreSQL の使用量を見てから決める
- nginx で MCP のパスの要求本文の大きさに上限を設け、DCR、認可、トークンの各エンドポイントには IP ごとのレート制限（`limit_req`）をかける
- MCP サーバー内で、Mattermost API の呼び出しにタイムアウトと同時実行数の上限を設ける
- ツール呼び出しにはアプリケーション内でレート制限をかける（MCP 2025-11-25 の Tools の Security Considerations）。claude.ai からの要求は Anthropic の共有の送信元から来るため、nginx の IP 単位の制限では代わりにならない
  - 数えるのはツールの呼び出し回数ではなく、実際に Mattermost API を呼んだ回数とする。1 回のツール呼び出しが複数の API 呼び出しになる場合（チームごとの検索など）も、その分を数える
  - Mattermost ユーザーごとの上限と、サーバー全体の上限の 2 段階にする
  - 上限を超えたら待たせ続けずに、すぐレート制限のエラーをツールの結果として返す
  - Mattermost が `429` を返したら自動で再試行せず、リセット時刻を添えてレート制限のエラーとして返す
  - 具体値は実装者が決める。目安は、利用者 1 人が会話の中で普通に使う量（数十回／分）を妨げず、全員が同時に上限まで使っても Mattermost の応答時間が目に見えて悪化しないこと。本番投入前にローカルで負荷をかけて確かめる
  - 利用者 1 人あたり 300 回／分、全体で 600 回／分とする。`list_my_channels` を起点に既定の 50 チャンネルを `read_channel` で巡回すると約 200 回かかるため 1 人あたりをこの値にし、全体の上限は runbook の「負荷の確認」で応答時間が悪化しないと確かめた値なので、1 人の上限を上げても Mattermost にかかる負荷の最大は変わらない
- 認可途中の状態と認可コードは短い期限（10 分程度）で消す。失効や期限切れになった grant とトークン、期限の過ぎた `send_message` の重複防止の記録も定期的に消す。DCR の登録は自動では消さず、総数の上限で抑える（「保存先」を参照）
- ログは journald ドライバー（`logging.driver: journald`）で出し、journald の容量制限に従わせる

### 配置

```text
インターネット ── nginx（443）─┬─ /mcp、/mcp/…、/.well-known/oauth-protected-resource/mcp、
                               │  /.well-known/oauth-authorization-server/mcp ─> mcp（新規コンテナ）
                               └─ それ以外 ─> mattermost:8065
mcp ──(https://mattermost.example.com、Compose 内部で nginx に解決)──> nginx ──> Mattermost API
```

- ソースは独立したリポジトリ `mattermost-mcp` に置く。本番 VM では `/opt/mattermost-mcp` に置き、`mattermost-infra` の Compose（`/opt/mattermost-infra/compose`）の新サービス `mcp` が `build: ../../mattermost-mcp` でビルドする。開発機でも 2 つのリポジトリを同じ親ディレクトリに並べる
- `mcp` のポートはホストに公開しない。nginx からだけ到達させる
- `mcp` から Mattermost の API とトークンエンドポイントへは、クライアントシークレットとトークンを送るため、証明書を検証する HTTPS で `https://mattermost.example.com` を呼ぶ（OAuth 2.1 と RFC 6750 は TLS を必須としている）。外部 IP を経由して VM に戻る通信にしないよう、Compose で nginx サービスにネットワークエイリアス `mattermost.example.com` を付け、`mcp` からはこの名前が nginx コンテナに解決されるようにする。証明書は既存のものがそのまま使える。`mcp` コンテナの接続元 IP が nginx の `access.conf` で拒否されないことを確かめる
- 利用者のブラウザを送る Mattermost の認可 URL と、パーマリンクにも同じ公開 URL を使う
- 既存の nginx の `location /` の設定（キャッシュなど）を MCP のパスに適用しない。MCP のパスは専用の `location` で受け、キャッシュとバッファリングを無効にする
- 既存の nginx で `server` 全体に有効になっている TLS 1.3 の Early Data（`ssl_early_data on`）を `off` にする。0-RTT で送られた要求は再送（リプレイ）されうるため、`send_message` の二重投稿や、リフレッシュ要求の再送によるリフレッシュトークン再利用検知の誤発火を招く。Mattermost 本体の POST も同じ危険を抱えており、0-RTT による短縮は 1 往復分にすぎないため、MCP のパスだけで `425` を返すより全体で無効にする
- `mcp` コンテナが止まっても Mattermost と nginx は動き続ける（nginx は起動時に `mcp` の名前解決を必要としない書き方にする。既存の `$mattermost_upstream` と同じ方式）
- Mattermost 側の準備は、System Console で OAuth 2.0 アプリを 1 つ作るだけ（confidential、コールバック URL は MCP サーバーのコールバック）。MCP サーバーが自分の同意画面を出すため、Mattermost 側の「信頼済み」は「はい」にして同意の二重表示を避けてよい。クライアント ID とシークレットは `mattermost-infra` の `compose/.env` で渡す

### 運用

- ログは JSON で出す。記録するのは時刻、Mattermost ユーザー ID、ツール名、結果（成功、失敗の種別）、所要時間。メッセージ本文、検索語、トークンは記録しない
- `/mcp/healthz` を Compose の healthcheck に使う

### テスト

- 認可フローとツールは、ローカルの Docker Compose で Mattermost Team Edition を立てて自動テストする。本番の Mattermost にテストのための書き込みをしない
- テストに使う Mattermost のバージョンは環境変数 `MATTERMOST_IMAGE_TAG` で指定し、未指定なら隣の `mattermost-infra` の `compose/.env`（なければ `compose/env.example`）の値を使う。どれも見つからなければテストを始めない。トークンの再利用、リフレッシュの競合、アプリの取り消しの挙動もこのテストで確かめる
- 「前提」の Mattermost のトークン再利用の挙動は v11.7.8 の実装に基づく。MCP サーバーの本番投入は Mattermost が v11.7.8 のうちに行い、その後 Mattermost を更新するときは、新しいバージョンでこのテストを通してから本番を更新する。テストが通らなければ、Mattermost の更新を止めて設計を見直す
- 本番投入後の確認は、作業者のアカウントで 3 つのクライアントから接続し、読み取り系のツールを一通り呼ぶ。書き込み系のツールは、作業者自身の DM（自分宛て）の中だけで確かめ、他のチャンネルや利用者の投稿には触れない

## 実装者に任せること

- TypeScript で書く（利用者の判断）。ランタイム、MCP SDK、Web フレームワーク、SQLite ドライバ、暗号化方式の選定
- 各種有効期限、件数と本文長の上限、リソース上限、レート制限の具体値
- 同意画面の見た目（上記の表示項目と保護を満たせばよい）
- OAuth エンドポイントの具体的なパス、ツールの入出力スキーマの細部

## 採らない設計

| 案 | 採らない理由 |
|---|---|
| Mattermost の DCR を有効にし、MCP クライアントを Mattermost に直接登録させる | token passthrough になる。public client にはリフレッシュトークンが出ず、再ログインが頻発する。DCR の登録エンドポイントが認証なしで公開され、Mattermost に OAuth アプリが無制限に作られる |
| Personal Access Token を利用者に発行してもらい、MCP クライアントに設定させる | 「URL を追加してログインするだけ」にならない。claude.ai の固定ヘッダーによる認証は限定提供で、組織共通の資格情報になるため、利用者ごとの権限で動くという要件を満たさない。トークンが失効しない |
| 同意を記憶して 2 回目以降の同意画面を省略する | 省略の判定には、Mattermost へ送る前に利用者を特定するセッション管理が要る。認可はクライアント追加時にしか起きないため、毎回表示しても負担は小さい |
| サブドメイン `mcp.example.com` で公開する | 利用者が `/mcp` を望んでいる。DNS と証明書の追加が要る。パス形式が使えなかった場合の代替として残す |
| 既存の PostgreSQL に保存する | 「保存先」を参照 |
