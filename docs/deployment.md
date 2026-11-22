# Deployment

How to deploy the MCP server in your own environment.
The MCP server runs as a Docker image behind a reverse proxy that terminates TLS (the examples use nginx).
For running it, see [operations.md](operations.md). For measured behavior, see [measurements.md](measurements.md).

## Deployment layouts

The MCP server keeps the URL it shows to MCP clients (`PUBLIC_URL`) separate from the Mattermost URLs (`MM_URL`, `MM_BROWSER_URL`).
Every URL is built from environment variables, and the request's `Host` and `X-Forwarded-*` headers are never read.
Both of the following layouts therefore work.

| Layout | Example | MCP endpoint | Settings |
|---|---|---|---|
| Same origin as Mattermost | Under `/mcp` of `https://chat.example.com` | `https://chat.example.com/mcp` | `PUBLIC_URL=https://chat.example.com`. `MM_URL` can be omitted |
| Separate host | `https://mcp.example.com` | `https://mcp.example.com/mcp` | `PUBLIC_URL=https://mcp.example.com`, `MM_URL=https://chat.example.com` |

- Make `PUBLIC_URL` the origin only (scheme, host and port). If it contains a path, the URLs in the metadata the MCP server returns no longer match the paths it actually accepts (`/mcp`, `/.well-known/...`)
- On the same origin, `/.well-known/oauth-authorization-server` at the root of the Mattermost domain stays Mattermost's. The MCP server sets the issuer to `<PUBLIC_URL>/mcp` and serves its metadata at the path-inserted form (`/.well-known/oauth-authorization-server/mcp`), so the two do not collide
- On the same origin, you cannot create a team named `mcp`. Mattermost team URLs are `/<team name>/...`, so once the reverse proxy sends everything under `/mcp/` to the MCP server, that team's pages become unreachable
- A separate host adds one DNS record and one certificate, but you do not have to touch the Mattermost reverse proxy configuration

Use HTTPS for `PUBLIC_URL`.
The consent screen cookie is issued with a name starting with `__Host-` and the `Secure` attribute, so browsers do not accept it over HTTP.
To connect from claude.ai, the server must also be reachable from the internet.

## 1. Check Mattermost beforehand

The OAuth behavior was measured on Mattermost 11.7.15 ([measurements.md](measurements.md)).
Before running on any other version, pass the integration tests on that version ([When updating Mattermost in operations.md](operations.md#when-updating-mattermost)).

| Item | Required state | If not met |
|---|---|---|
| Version | 11.7.15 (the version the integration tests passed on) | On an unverified version, the assumptions about token reuse and refresh may not hold |
| `ServiceSettings.EnableOAuthServiceProvider` | `true` ("Enable OAuth 2.0 Service Provider" under Integrations > Integration Management in the System Console) | You cannot create the OAuth app, so no one can log in |
| `ServiceSettings.AllowSyncedDrafts` | `true` (the default) | `save_draft` only returns "Draft sync is disabled on this server." |
| `FileSettings.EnableFileAttachments` and `MaxFileSize` | `true`, and larger than the attachment limits (128KiB for `files` of `send_message`, `UPLOAD_MAX_BYTES` for `prepare_upload`) | Attachments of `send_message` and uploads to the `prepare_upload` URL fail |
| `SqlSettings.DataSourceReplicas` and `DataSourceSearchReplicas` | Empty (and not added through environment variables such as `MM_SQLSETTINGS_DATASOURCEREPLICAS`) | The window between `save_draft` checking for an existing draft and saving widens by the replica lag, and a draft the user wrote in the UI in the meantime can be overwritten |
| A team named `mcp` (including archived ones) | None (only when using the same origin) | As in "Deployment layouts" above, that team becomes unreachable |
| `RateLimitSettings` and `ServiceSettings.TrustedProxyIPHeader` | Read the explanation below and decide | MCP calls compete for Mattermost's rate limit quota |

To check the setting values, use an API that reflects values overridden by environment variables.
Open `<Mattermost URL>/api/v4/config/client?format=old` in a browser logged in as a system administrator to see `AllowSyncedDrafts`, `EnableFileAttachments` and `MaxFileSize` (some items do not appear when you are not logged in).
Check for an `mcp` team, archived ones included, in the database.

```sql
SELECT name, deleteat FROM teams WHERE name = 'mcp';
```

Mattermost's rate limit (when `RateLimitSettings.Enable` is `true`) also applies to MCP calls.
The quota is divided as follows (`server/channels/app/ratelimit.go` in v11.7.15).

- `VaryByUser` is `true`: quotas are split per token. The MCP server calls with each user's own OAuth token, so every user gets a separate quota, and it is not shared with that user's web or app sessions
- `VaryByUser` is `false` and `VaryByRemoteAddr` is `true`: quotas are split per source IP. Calls from the MCP server for all users come from the same source (the address of the MCP server, or of the reverse proxy it goes through), so they share one quota. If `TrustedProxyIPHeader` is empty, web and app users behind the reverse proxy fall into the same quota, and heavy MCP traffic also returns 429 to the web and apps

When Mattermost returns 429, the MCP server does not retry and returns it in the tool result as a rate limit error.
If you use a setting where all users share one quota and 60 times `PerSec` is below the MCP server's overall limit (600 calls per minute), decide whether to change the Mattermost settings or to accept this effect.

## 2. Create the OAuth app

Create one OAuth 2.0 app in Mattermost.

| Item | Value | Reason |
|---|---|---|
| Type | confidential (`is_public: false`) | Mattermost does not issue refresh tokens to public clients, which causes frequent re-logins |
| Trusted (`is_trusted`) | Yes | The MCP server shows its own consent screen, so this avoids showing consent twice on the Mattermost side |
| Callback URL | Only `<PUBLIC_URL>/mcp/oauth/callback` | |
| Display name | Any (for example `mcp-server-for-mattermost`) | The name users see when they revoke it under Settings > Security > OAuth 2.0 Apps |

To create it in the UI, open `<Mattermost URL>/<team name>/integrations/oauth2-apps/add` as a system administrator.
"Trusted" is shown only to system administrators.
To create it with an administrator token, do the following.

```bash
read -rs MM_ADMIN_TOKEN
curl -s -X POST https://chat.example.com/api/v4/oauth/apps \
  -H "Authorization: Bearer $MM_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"mcp-server-for-mattermost","description":"MCP server","homepage":"https://github.com/yui666a/mcp-server-for-mattermost","callback_urls":["https://mcp.example.com/mcp/oauth/callback"],"is_trusted":true,"is_public":false}' \
  | jq '{id, client_secret, is_trusted, is_public, callback_urls}'
unset MM_ADMIN_TOKEN
```

`id` is the client ID (`MM_OAUTH_CLIENT_ID`), and `client_secret` is the client secret (`MM_OAUTH_CLIENT_SECRET`).

## 3. Environment variables

| Name | Required | Default | Description |
|---|---|---|---|
| `PUBLIC_URL` | Yes | | The origin shown to MCP clients. No trailing slash. The resource and the issuer are this plus `/mcp` |
| `MM_OAUTH_CLIENT_ID` | Yes | | ID of the OAuth app |
| `MM_OAUTH_CLIENT_SECRET` | Yes | | Secret of the OAuth app |
| `TOKEN_ENC_KEY` | Yes | | Base64 of a 32-byte key that encrypts Mattermost tokens and the bodies of scheduled messages (`openssl rand -base64 32`) |
| `MM_URL` | | `PUBLIC_URL` | The Mattermost URL the MCP server calls for the API and the token endpoint. No trailing slash |
| `MM_BROWSER_URL` | | `MM_URL` | The Mattermost URL the user's browser is sent to. Permalinks are also built with it |
| `DB_PATH` | | `/data/mcp.sqlite` | SQLite file |
| `PORT` | | `3000` | Port to listen on |
| `LOCALE` | | `en` | Language of tool descriptions, tool output, the consent screen and the admin commands. `en` or `ja`. An empty string is treated as the default, and any other value makes startup fail with `LOCALE must be en or ja` |
| `TIME_ZONE` | | `UTC` | IANA name of the time zone in which times are read and written (for example `Asia/Tokyo`). Times without an offset and search dates are read in this time zone, and output shows both UTC and this time zone. An empty string is treated as the default, and any other value makes startup fail with `TIME_ZONE must be an IANA time zone name` |
| `ACCESS_TOKEN_TTL_SEC` | | `3600` | Lifetime of the MCP access token (seconds). Shorten it only when verifying refresh |
| `EXTRA_REDIRECT_URIS` | | | Additional redirect URIs allowed for registration (comma-separated, exact match). claude.ai, claude.com and loopback are allowed by default |
| `EXTRA_ALLOWED_ORIGINS` | | | Additional `Origin` values allowed on `/mcp` (comma-separated). The default is `https://claude.ai` and `https://claude.com`. Requests without an `Origin` (CLI) are not checked |
| `UPLOAD_MAX_BYTES` | | `10485760` (10MiB) | Upper limit (bytes) of the request body that one request to the `prepare_upload` URL can send. It counts the whole body including the multipart framing. Set the reverse proxy's body limit for `/mcp/upload/` to this plus 1MiB |

Do not regenerate `TOKEN_ENC_KEY`.
If you change it, the stored Mattermost tokens become unreadable and everyone has to log in again, and pending scheduled messages fail because their bodies cannot be decrypted.

`MM_URL` is where the client secret and tokens are sent, so use HTTPS with a certificate that can be verified.
When you want the reverse proxy to resolve Mattermost's public URL within the same Docker host, attach Mattermost's public hostname as a network alias to the reverse proxy service in Compose.
Attach this alias to a network shared only with the MCP server.
If you attach it to a network that Mattermost is also on, Mattermost also resolves its own site name to a private IP, and Mattermost's outbound traffic can be rejected as connections to reserved IPs.

## 4. Start

Build the image from the `Dockerfile` at the repository root.
The container runs as UID 1000 (`node`) and writes the SQLite file (including the WAL files `-wal` and `-shm`) to `/data`.

An example of a minimal `compose.yml`. It assumes the reverse proxy runs on the same host and forwards to `127.0.0.1:3000`.

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
    # Wait longer than the default 10 seconds so an in-flight send_message can run to the call deadline (25 seconds)
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
# The DB also holds unencrypted data such as scheduled message bodies, so make it unreadable to other users on the host
mkdir data && sudo chown 1000:1000 data && sudo chmod 700 data
# Write MM_OAUTH_CLIENT_ID, MM_OAUTH_CLIENT_SECRET and TOKEN_ENC_KEY to .env and chmod 600 it
docker compose up -d --build
docker compose ps    # wait until it is healthy (the healthcheck interval is the default 30 seconds)
```

- The resource limits are the measured peak memory of 86 MiB, under a load where 6 people kept calling up to the overall limit, plus headroom ([Load in measurements.md](measurements.md#load)). Uploads to the `prepare_upload` URL hold the request body and the file in memory and process only one at a time across the whole server. When a body of the default 10MiB was sent, memory usage grew by about 80MB (about 8 times the body). If you raise `UPLOAD_MAX_BYTES` above the default, raise `mem_limit` too, using 8 times that as a guide
- Run the MCP server as a single process. Preventing double execution of scheduled messages, serializing token refresh, and serializing draft saves and the draft deletion after `send_message` all happen inside the process, so do not point multiple processes at the same SQLite file
- On `SIGTERM` it refuses new connections, waits for in-flight requests to finish, and stops with exit code 0

## 5. Reverse proxy

Forward the following four paths to the MCP server. With a separate host, you can forward all paths of that host.

| Path | Purpose |
|---|---|
| `/mcp` | MCP Streamable HTTP (POST only) |
| Under `/mcp/` | The OAuth endpoints (`/mcp/oauth/register`, `authorize`, `consent`, `callback`, `token`), `/mcp/healthz`, and the upload URL of `prepare_upload` (`/mcp/upload/<token>`) |
| `/.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata (RFC 9728) |
| `/.well-known/oauth-authorization-server/mcp` | Authorization Server Metadata (RFC 8414) |

Configure the following on the reverse proxy.

- **Request body limit**: 1 MB. The MCP server itself also rejects `/mcp` bodies above 1 MiB. The attachment limit (128KiB) is chosen so that, even if the text expands up to 6 times through JSON escaping, it still fits within this 1 MB together with the longest message body. Only `/mcp/upload/` is raised to `UPLOAD_MAX_BYTES` plus 1MiB (11 MB by default). Raise only this path, and keep the regular MCP route at 1 MB. For a body that exceeds the limit by up to 1MiB, the MCP server reads it to the end and then sends back 413 with an explanation of how to resend, and for anything larger it closes the connection without reading. So if the reverse proxy limit is smaller, users get the reverse proxy's own 413 with no explanation, and if it is larger, the connection can be cut during sending and become a 502. Also leave request body buffering (`proxy_request_buffering` in nginx) at its default of on. The MCP server aborts an upload that receives no data for 15 seconds while waiting for the body, but it cannot abort a sender that keeps trickling data, and that sender holds the single concurrent processing slot in the meantime, so let the reverse proxy absorb slow senders
- **Disable caching and buffering**: Do not let the cache of the `location /` for Mattermost apply to the MCP paths
- **Per-IP rate limit on the OAuth endpoints**: The registration endpoint is public without authentication, so a third party can pile up registrations. The MCP server does not look at the source IP, so apply the limit on the reverse proxy. Express does not distinguish letter case or a trailing slash in paths, so match everything under `/mcp/oauth/` with a case-insensitive match to bring altered paths into the quota too. Do not apply a per-IP limit to `/mcp` itself. Requests from claude.ai come from Anthropic's shared sources, so all users would share one quota (tool calls are limited per user inside the MCP server). For the same reason, all claude.ai users also share one quota on the OAuth endpoints, so if connections from claude.ai get 429, widen the quota
- **Disable TLS 1.3 0-RTT (Early Data)**: Requests sent in 0-RTT can be replayed. That causes duplicate posts from `send_message`, and false triggers of refresh token reuse detection when a refresh request is replayed (all tokens of that grant are revoked). If the 0-RTT setting applies to the whole `server`, POSTs to Mattermost itself carry the same risk, so it is fine to disable it for the whole server
- If the MCP server calls Mattermost through the same reverse proxy via `MM_URL`, the MCP server's source address must not be rejected by access restrictions

An nginx example for a separate host.

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

        # proxy_pass is not inherited by nested locations, so repeat it
        location ~* ^/mcp/oauth/ {
            limit_req zone=mcp_oauth burst=30 nodelay;
            limit_req_status 429;
            proxy_pass http://127.0.0.1:3000;
        }
        # ~* because Express does not distinguish letter case in paths. /MCP/UPLOAD/... gets the same limit
        location ~* ^/mcp/upload/ {
            client_max_body_size 11m;
            # Sends up to 5 files to Mattermost one at a time, and one call is cut off at 25 seconds
            proxy_read_timeout 180s;
            proxy_pass http://127.0.0.1:3000;
        }
    }
}
```

To use the same origin as Mattermost, add four `location` blocks with the same contents to Mattermost's `server` and set `ssl_early_data off`.

```nginx
location = /mcp { ... }
# ^~ so that paths such as /mcp/.../websocket are not taken by Mattermost's regex location for WebSocket
location ^~ /mcp/ {
    ...
    location ~* ^/mcp/oauth/ { limit_req zone=mcp_oauth burst=30 nodelay; limit_req_status 429; proxy_pass ...; }
    location ~* ^/mcp/upload/ { client_max_body_size 11m; proxy_read_timeout 180s; proxy_pass ...; }
}
location = /.well-known/oauth-protected-resource/mcp { ... }
location = /.well-known/oauth-authorization-server/mcp { ... }
```

If you use a variable for `proxy_pass` (`set $mcp_upstream http://mcp:3000;` and a `resolver`), nginx does not resolve the MCP server's name at startup or reload.
nginx can then start even when the MCP server is down, and Mattermost stays usable while only the MCP paths return 502.

## 6. Verify the deployment

```bash
curl -s https://mcp.example.com/mcp/healthz
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp | jq .
curl -s https://mcp.example.com/.well-known/oauth-authorization-server/mcp | jq .
```

- `/mcp/healthz` returns `{"ok":true}`
- In the protected resource metadata, `resource` is `<PUBLIC_URL>/mcp`, `authorization_servers` is `["<PUBLIC_URL>/mcp"]`, and `scopes_supported` is `["mattermost"]`
- In the authorization server metadata, `issuer` is `<PUBLIC_URL>/mcp`, each endpoint is `/oauth/authorize`, `/oauth/token` or `/oauth/register` under it, and `code_challenge_methods_supported` is `["S256"]`
- If you used the same origin, also confirm that logging in to Mattermost on the web, posting, and a post from another device appear without a reload (WebSocket)

Then connect from an MCP client and call each of the tools ([Post-deployment checks in operations.md](operations.md#post-deployment-checks)).
