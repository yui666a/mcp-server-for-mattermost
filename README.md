# mcp-server-for-mattermost

[日本語](README-ja.md)

A remote [MCP](https://modelcontextprotocol.io/) server that lets AI clients (claude.ai, Claude Code, Codex CLI, and other MCP clients) read and post to Mattermost **as each user**.
Users add one URL as a connector and sign in with their own Mattermost account; the server only ever sees and does what that user can.

> Tool descriptions, tool output, the consent page, and the documents under `docs/` are written in Japanese.

## Why this exists

Mattermost ships an official MCP server inside the [Mattermost Agents plugin](https://mattermost.com/blog/mattermost-mcp-server/).
Its documentation lists Mattermost Server v12.0 or later, and an Enterprise license or higher to turn on the HTTP endpoint that external clients connect to.
It offers a much larger tool catalog (about 120 tools).
If you have that license and version, it is the natural choice.

This project targets the other case:

- **Standalone.** It runs as its own container beside an existing Mattermost and needs no plugin. It talks to Mattermost only through the REST API and its OAuth 2.0 service provider.
- **Works with Team Edition.** It is developed and tested against Mattermost Team Edition 11.7.8.
- **Per-user OAuth with its own authorization server.** MCP clients register themselves (Dynamic Client Registration) and receive tokens that are valid only for this server. The user's Mattermost tokens are kept server-side, encrypted, and are never handed to the MCP client (no token passthrough). Every authorization shows a consent page that displays the client's redirect URI.
- **Scheduled posts on Team Edition.** Mattermost's scheduled-post API is not available on Team Edition, so the server stores scheduled posts itself and posts them with the user's token when they are due.
- **Guard rails for an LLM caller.** It suppresses duplicate posts when a client retries, edits and deletes only the user's own posts, refuses to delete a thread root that has replies, does not overwrite a different draft unless asked, and clears a draft with the same text in the same place once that text is posted with `send_message` (scheduled posts leave it).

## Tools

| Tool | Purpose |
|---|---|
| `search_posts` | Search messages in the user's teams with Mattermost search syntax (`from:`, `in:`, `before:`, ...). `in:` accepts channel names and `@username` too, without creating a DM |
| `read_channel` | Read a channel's posts, newest first |
| `read_thread` | Read a thread's root and replies, oldest first |
| `get_post` | Read one post by post ID or permalink URL |
| `get_file` | Read an attached file; images are returned as a preview image, and text (UTF-8, or Shift_JIS for csv/tsv/txt/log) as up to its first 10,000 characters |
| `search_channels` | Find channels (public, joined private, DMs, group DMs) by name |
| `list_my_channels` | List joined channels by most recent post |
| `get_channel` | Channel type, purpose, header, member count, and pinned posts |
| `get_unreads` | Unread channels and, with collapsed reply threads, unread threads |
| `get_mentions` | Posts that mention the user |
| `search_users` | Find users by name or username |
| `get_user` | A user's profile with time zone, local time, and status |
| `send_message` | Post to a channel or thread, optionally with small inline files or files uploaded through `prepare_upload`; clears a draft with the same text afterwards |
| `prepare_upload` | Issue a one-time URL for uploading local files (screenshots, PDFs, photos) with `curl`; for clients that can run commands on the user's machine, such as Claude Code and Codex CLI |
| `add_reaction` / `remove_reaction` | Add or remove the user's own reaction |
| `edit_message` / `delete_message` | Edit or delete the user's own post |
| `save_draft` | Save a Mattermost draft for the user to send from the UI; sending the same text with `send_message` clears it |
| `schedule_message` | Schedule a post for a later time (1 minute to 30 days ahead) |
| `list_scheduled_messages` | List the user's scheduled posts with status and permalink |
| `update_scheduled_message` / `cancel_scheduled_message` | Change or cancel a pending scheduled post |

Times are in JST: a `schedule_message` time without an offset (`YYYY-MM-DDTHH:mm[:ss[.sss]]`) is read as `+09:00`, so append `Z` or `+hh:mm` (`-hh:mm`) for another zone. Search dates (`on:`, `before:`, `after:`) are JST days, and output shows each time in both UTC and JST.

Each post in the output of the read tools also shows its message attachments (the formatted content bots and webhooks post, which Mattermost's default database search does not cover), its reactions with who reacted, when it was edited, and whether it is a system message.

Read-only tools carry the MCP `readOnlyHint` annotation so clients can ask before writes.

## Architecture

```text
MCP client ──(MCP token)──> mcp-server-for-mattermost ──(user's Mattermost token)──> Mattermost REST API
     │                                │
     └─ sign-in: /mcp/oauth/authorize ─> consent page ─> Mattermost /oauth/authorize (login)
```

- Streamable HTTP at `<PUBLIC_URL>/mcp`, stateless, POST only.
- OAuth metadata at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/mcp` (path-inserted form, so it can share an origin with Mattermost's own metadata).
- One confidential OAuth app registered in Mattermost; one process; state in a SQLite file.
- Per-user and global limits on Mattermost API calls (300 and 600 per minute), plus timeouts and concurrency caps.

The full design is in [docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md](docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md).

## Requirements

- Mattermost with the OAuth 2.0 service provider enabled. Tested with Team Edition 11.7.8; run the integration tests before using another version.
- Node.js 26 or later and pnpm 11 (pinned through `packageManager`) for development; Docker for running the server and the local Mattermost.
- An HTTPS origin for the server and a reverse proxy in front of it.

## Quick start (local)

```bash
pnpm install
pnpm dev:up    # starts Mattermost 11.7.8 on http://localhost:8065 and writes dev/.state.json
```

`pnpm dev:up` creates the users `admin`, `alice`, and `bob` (password `Passw0rd!dev123`), two teams, the load-test users `load1` to `load6`, and an OAuth app whose callback is `http://localhost:3000/mcp/oauth/callback`.
Set `MATTERMOST_IMAGE_TAG` to try another Mattermost version.

Start the server against it:

```bash
export PUBLIC_URL=http://localhost:3000 MM_URL=http://localhost:8065
export MM_OAUTH_CLIENT_ID=$(node -p "require('./dev/.state.json').oauth.clientId")
export MM_OAUTH_CLIENT_SECRET=$(node -p "require('./dev/.state.json').oauth.clientSecret")
export TOKEN_ENC_KEY=$(openssl rand -base64 32) DB_PATH=/tmp/mcp-dev.sqlite
pnpm start
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
```

The consent page sets a `__Host-` cookie with `Secure`, so to sign in from a real MCP client, put the server behind an HTTPS tunnel, set `PUBLIC_URL` to the tunnel's origin, and point the OAuth app at it with `node dev/setup.ts --callback https://<tunnel>/mcp/oauth/callback`.

Tests:

```bash
pnpm test        # unit tests
pnpm typecheck
pnpm test:int    # integration tests against the local Mattermost (needs pnpm dev:up)
pnpm dev:down    # stop the local Mattermost and delete its data
```

## Deploying

See [docs/deployment.md](docs/deployment.md) for the Mattermost settings to check, creating the OAuth app, environment variables, a `compose.yml` example, and the reverse-proxy requirements with an nginx example.
The server can share Mattermost's origin (under `/mcp`) or run on its own host.

## Connecting a client

Use `<PUBLIC_URL>/mcp`, for example `https://mcp.example.com/mcp`.

- **Claude Code**: `claude mcp add --transport http mattermost https://mcp.example.com/mcp`, then sign in from `/mcp`.
- **claude.ai**: add a custom connector with the URL.
- **Codex CLI**: `codex mcp add mattermost --url https://mcp.example.com/mcp`, then `codex mcp login mattermost`.

Measured client behavior is in [docs/measurements.md](docs/measurements.md).

## Documentation

- [docs/deployment.md](docs/deployment.md): deploying on your own infrastructure
- [docs/operations.md](docs/operations.md): post-deploy checks, logs, admin commands, upgrading Mattermost and this server, backup and restore, troubleshooting
- [docs/measurements.md](docs/measurements.md): measured Mattermost OAuth behavior, client compatibility, load test
- [docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md](docs/superpowers/specs/2026-11-01-mattermost-mcp-design.md): design

## License

[MIT](LICENSE)

Mattermost is a trademark of Mattermost, Inc. This project is not affiliated with, sponsored by, or endorsed by Mattermost, Inc.
