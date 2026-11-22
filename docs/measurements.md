# Measured behavior

Results of measuring the Mattermost and MCP client behavior that the design and implementation rely on.
When you update Mattermost, confirm these assumptions again with the integration tests (`pnpm test:int`) ([When updating Mattermost in operations.md](operations.md#when-updating-mattermost)).

## Measured Mattermost OAuth behavior

Results measured with `test/int/mattermost-oauth.test.ts` against a local Mattermost 11.7.15 (`dev/compose.yml`, the OAuth app is confidential with `is_trusted: true`). Of the design assumptions, token reuse, refresh token rotation and `pending_post_id` deduplication held. Invalidation of the old access token by a refresh did not hold (see "Old access token after a refresh" below).

### Token exchange and refresh

- The endpoint is `POST {MM_URL}/oauth/access_token`, and the body is `application/x-www-form-urlencoded`.
- The required parameters of the authorization code exchange are `grant_type=authorization_code`, `code`, `client_id`, `client_secret` and `redirect_uri`. Do not omit `redirect_uri`. Omitting it, or giving a value different from the one used at authorization, returns 400 `api.oauth.get_access_token.redirect_uri.app_error`. A used `code` returns 400 `api.oauth.get_access_token.expired_code.app_error`.
- The required parameters of a refresh are `grant_type=refresh_token`, `refresh_token`, `client_id` and `client_secret`. `redirect_uri` is not needed (adding it still returns 200). Omitting `client_secret` or giving a wrong one returns 401 `model.oauth.validate_grant.credentials.app_error`.
- The response has `access_token`, `refresh_token`, `token_type: bearer`, `expires_in`, `scope` and `id_token`. `expires_in` is 2592000 (30 days), fixed regardless of the lifetime of the MCP-side access token.
- Authorizing again with the same user and the same app returns the same `access_token` and `refresh_token` while they are within their lifetime (confirmed in a test).
- A refresh returns a new `access_token` and `refresh_token`, and the used `refresh_token` can never be used again.
- The old `access_token` stays valid right after the refresh (`/api/v4/users/me` still returns 200 after 8 seconds). Do not treat invalidation of the old `access_token` as the basis for a `401`. For details, see "Old access token after a refresh" below.

### When a re-login is needed

An error response has the shape `{"id", "message", "detailed_error", "request_id", "status_code"}`, and the OAuth `error` value appears only at the start of `message` (`invalid_grant: ...`). There is no separate `error` field. The decision is made on the HTTP status and `id`.

| Situation | HTTP | `id` | Re-login |
|---|---|---|---|
| A used `refresh_token` | 404 | `api.oauth.get_access_token.refresh_token.app_error` | Needed |
| A `refresh_token` that does not exist | 404 | Same as above | Needed |
| The user revoked the app (`POST /oauth/deauthorize`) | 404 | Same as above | Needed |
| The user was deactivated (`DELETE /api/v4/users/{id}`) | 404 | Same as above | Needed |
| `refresh_token` missing | 400 | `api.oauth.get_access_token.missing_refresh_token.app_error` | Not needed (an implementation mistake) |
| `client_secret` missing or mismatched | 401 | `model.oauth.validate_grant.credentials.app_error` | Not needed (a configuration mistake) |

- The MCP server asks for a re-login only when a refresh returns 404 with `id` of `api.oauth.get_access_token.refresh_token.app_error`, and for the 403 below.
- The deactivation 404 happens because deactivation deletes `OAuthAccessData`. The v11.7.15 source also has a branch that returns 403 `api.oauth.get_access_token.expired_code.app_error` when `OAuthAccessData` remains and `DeleteAt != 0`. It was not reached locally, but the MCP server treats this 403 as a re-login too.
- Revocation is `POST {MM_URL}/oauth/deauthorize` with the body `{"client_id": "..."}`, and it needs the user's cookie (`MMAUTHTOKEN`) plus either `X-Requested-With: XMLHttpRequest` or `X-CSRF-Token` (the value of the `MMCSRF` cookie). It returns 401 when neither is present or when the `X-CSRF-Token` value is wrong. The cookie is sent in `Set-Cookie` only when the login request carries `X-Requested-With: XMLHttpRequest`.

### Old access token after a refresh

- After authorizing with the same user and the same app and refreshing, `GET /api/v4/users/me` was called with the old `access_token` every 15 seconds. It stayed at 200 until 841 seconds (about 14 minutes) after the refresh and never became 401. The new `access_token` also returned 200 at the same time.
- It kept returning 200 beyond the 10 minutes of Mattermost's session cache (`SessionCacheInMinutes`, default 10), so this is not a temporary remnant of the cache. The session tied to the old `access_token` is not invalidated by the refresh, and appears to stay valid until the session's own expiry (`SessionLengthSSOInDays`, default 30 days, which matches the 2592000 of `expires_in`). It was not measured out to 30 days.
- The only case where the old `access_token` was confirmed to become 401 is when the user revoked the app (`POST /oauth/deauthorize`).
- The MCP server re-reads the stored credentials when Mattermost returns 401, so its behavior does not change even if the old token remains. Mattermost tokens never leave the MCP server, but an old token after a refresh remains a risk if the storage is leaked.

### Deduplication by `pending_post_id`

- Calling `POST /api/v4/posts` twice with the same `pending_post_id` returns 201 the second time, with the same `id` as the first post (confirmed in a test).

## Client compatibility

A temporary HTTPS tunnel was put in front of the MCP server to expose `/mcp`, and 3 clients connected through it. With `ACCESS_TOKEN_TTL_SEC=120`, a temporary tool placed only for this check (it returns Mattermost's `/api/v4/users/me`; the current tools do not have it) was called twice more than 2 minutes apart, which also checked the call after a refresh. All succeeded both times (2026-11-01).

| Client | `redirect_uris` of the registration (DCR) | Authorization request | Code exchange | Refresh |
|---|---|---|---|---|
| Codex CLI 0.166.0 | `http://127.0.0.1:<port>/callback/<id>` | `resource`, `scope=mattermost`, S256 | With `resource` | With `resource` and `scope` |
| Claude Code 2.1.316 | `http://localhost:<port>/callback` | `resource`, `scope=mattermost`, S256 | With `resource` | With `resource`, without `scope` |
| claude.ai | `https://claude.ai/api/mcp/auth_callback` | `resource`, `scope=mattermost`, S256 | With `resource` | With `resource`, without `scope` |

- Every client found the path-inserted metadata (`/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/mcp`) and registered with `token_endpoint_auth_method=none`.
- claude.ai sent DCR twice for one connection. The registration of the client that is not used remains.
- Codex refreshes after an unauthenticated request returns 401. Claude Code and claude.ai refresh before using an access token that is close to expiry.
- With a lifetime of 120 seconds, Claude Code refreshed on every request, 5 times in a row within about 1 second. The 5 were serial and all returned 200. Sending the same refresh token concurrently was not observed. If it were sent, the grant would be revoked as a reuse and a re-login would follow.
- Claude Code and claude.ai send `server/discover` after authentication. The server returned 400, and the client moved on to the next request as it was.
- claude.ai sometimes sends `tools/call` without sending `initialize`. The server is stateless, so it can handle this request too.

## Load

Measured with a local Mattermost 11.7.8 (`dev/compose.yml`) connected to an `mcp` container with the same limits as the `compose.yml` example in [deployment.md](deployment.md#4-start) (`cpus: 0.5`, `mem_limit: 256m`, `pids_limit: 128`, `read_only`) (2026-11-01, a development machine running Docker, 12 CPUs). Six users, `load1` to `load6` created by `dev/setup.ts`, each kept calling `read_channel` (`general-dup` of `team-a`, the default 30 posts) with 4 in parallel for 190 seconds. On a rate limit error they waited 250 ms and called again. Meanwhile a separate session (a login of `alice`) called `GET /api/v4/users/me` every 200 ms to measure the response time.

| | Count | Median | 95th percentile | Max |
|---|---|---|---|---|
| No load (120 seconds) | 585 | 3.4 ms | 6.4 ms | 13.6 ms |
| Under load (180 seconds) | 883 | 2.3 ms | 4.6 ms | 9.1 ms |
| Under load, only the seconds in which tool calls were succeeding | 56 | 2.3 ms | 5.1 ms | 7.4 ms |

- There were 517 successful tool calls in 190 seconds (163 per minute). One `read_channel` calls the Mattermost API about 3.7 times, so the load was pinned at the overall limit of 600 calls per minute. The other 17376 calls were rate limit errors and never reached Mattermost
- The limit is a 60-second sliding window, so calls to Mattermost come out in bursts the moment the window opens (the successes were concentrated in 10 of the 190 seconds, up to 94 calls per second). Even in those seconds the 95th percentile was lower than with no load, and no degradation was seen. The overall limit of 600 calls per minute is unchanged
- Memory of `mcp` peaked at 86 MiB (34 % of the 256 MiB limit), and CPU peaked at 56 % in `docker stats` (a value where 1 CPU is 100 %; `cpus: 0.5` corresponds to 50 %, and the measurement was near it)
- The measurement did not go through nginx and TLS (directly from `mcp` to `http://mattermost:8065`) and was done on a 12-CPU development machine. In an environment that goes through a reverse proxy and TLS and runs on a host with fewer CPUs, the absolute response times and the headroom can be smaller
- `docker stop` printed `shutting_down` and stopped with exit code 0
