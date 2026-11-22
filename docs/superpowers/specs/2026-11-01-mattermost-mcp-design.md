# Remote MCP Server for Mattermost: Design

## Purpose

Let Claude (claude.ai and the desktop app), Claude Code and Codex read and write Mattermost messages, in the same way as the Slack Connector.
A user starts using it just by adding the MCP server's URL (for example `https://mattermost.example.com/mcp`) as a connector and logging in with their Mattermost account.

Mattermost's official MCP server is part of the Agents plugin, and its HTTP endpoint for external MCP clients requires an Enterprise or higher license.
To make it usable with the free Team Edition too, this is built as an independent MCP server that runs outside Mattermost.

## Goals

- Connect from three clients, the claude.ai custom connector, Claude Code (`claude mcp add --transport http`) and Codex CLI, just by registering the URL and logging in with OAuth
- Each user acts with the permissions of their own Mattermost account. Channels and messages the user cannot see are not visible through MCP either
- The following operations are available
  - Searching messages
  - Reading a channel from its latest messages, from the first unread, or from a specified date and time range, and reading a thread
  - Reading a single post specified by a permalink URL or a post_id
  - Reading files attached to a post (an image as a downscaled image, a text file as its beginning) and searching files by name
  - Listing the posts the user saved (flagged)
  - Searching channels and users, and viewing user profiles
  - Viewing a user's time zone, local time and presence
  - Listing the channels the user has joined
  - Viewing a channel's type, purpose, header, member count and pinned posts
  - Listing the members of a channel the user may read (normally a channel the user has joined)
  - Listing the user's own unreads (channels and threads) and mentions of the user (which can also be limited to unread ones)
  - Marking the user's own channels and threads as read (up to the posts the AI has read)
  - Listing followed threads, and following and unfollowing threads
  - Posting to channels and threads (including attaching small files)
  - Adding and removing the user's own reactions on posts
  - Saving (flagging) and pinning or unpinning posts in joined channels (unsaving works regardless of membership)
  - Searching, by name, the custom emoji used for reactions and custom statuses
  - Changing the user's own presence and custom status
  - Editing and deleting the user's own posts
  - Saving a draft as the user's own Mattermost draft (the user sends it on screen)
  - Scheduling a post to a channel or thread at a specified time, and listing, changing and cancelling scheduled posts
- Once logged in, the user can keep using it without logging in again until they revoke it, as long as they keep using it (tokens are renewed with refresh tokens)

## Non-goals

- Editing or deleting other people's posts, creating channels and managing members
- System administration operations (user management, changing settings)
- Notifying MCP clients of Mattermost events (subscriptions, notifications)
- Supporting multiple Mattermost servers

## What to avoid

- Mattermost being operated through the MCP server with permissions other than the user's own
- A user's Mattermost permissions being handed to an MCP client the user did not intend
- Posting to an unintended channel
- Mattermost itself going down or slowing down. Failures or overload of the MCP server must not spread to the use of Mattermost
- Mattermost access tokens or message bodies remaining in logs

## Assumptions (confirmed as of 2026-11-01)

| Item | Value |
|---|---|
| Mattermost | Behavior was checked on v11.7.8 Team Edition. Other versions are used only after passing the integration tests ("Tests") |
| Reverse proxy | Placed behind a reverse proxy that terminates TLS (nginx in the examples) |
| OAuth 2.0 Service Provider | Enabled. It publishes `/.well-known/oauth-authorization-server` and has no `registration_endpoint` (Dynamic Client Registration is disabled) |
| Mattermost's OAuth | Authorization code flow, and PKCE only with `S256`. Public clients are not issued refresh tokens, and confidential clients (`client_secret_post`) are. The only scope is `user` |
| Mattermost's token reuse | For the same pair of user and OAuth app, a new authorization returns the existing access token and refresh token. Refreshing replaces the refresh token with a new one, and the used one can no longer be used. In a measurement on a local v11.7.8, the old access token stayed valid for at least 826 seconds after a refresh, and became invalid when the user revoked the app's permission ([`oauth.go` of v11.7.8](https://github.com/mattermost/mattermost/blob/v11.7.8/server/channels/app/oauth.go); details of the measurement are in `docs/measurements.md`). Mattermost's tokens never leave the MCP server, so the old access token remaining has no effect on the design |
| Draft sync | Only when the server setting `ServiceSettings.AllowSyncedDrafts` (default true) is enabled does a draft saved through the API reach the user's screen. When it is disabled, the drafts API returns 501. Check before deployment whether it is enabled at the deployment site (["Check Mattermost beforehand"](../../deployment.md#1-check-mattermost-beforehand) in `docs/deployment.md`) |
| Attachment settings | On a local v11.7.8, `FileSettings.EnableFileAttachments` is true and `MaxFileSize` is 100 MiB. When `EnableFileAttachments` is false, uploads return 403 and attachments in `send_message` cannot be used. The preview (the downscaled version `get_file` returns) is not a setting; Mattermost creates it when an image is uploaded. Check the values at the deployment site before deployment (["Check Mattermost beforehand"](../../deployment.md#1-check-mattermost-beforehand) in `docs/deployment.md`) |
| Number of Mattermost nodes | Assumes a setup without a replica from which the list of drafts is read. Check before deployment that the deployment site has no replica (["Check Mattermost beforehand"](../../deployment.md#1-check-mattermost-beforehand) in `docs/deployment.md`) |
| Users | Dozens of users per Mattermost. May be used from all over the world |

## Architecture

### Approach: the MCP server has its own authorization server and delegates login to Mattermost

Under the MCP specification (2025-06-18 and later), an MCP server must accept only tokens issued for itself, and passing a received token straight through to a downstream API (token passthrough) is prohibited.
Mattermost v11.7.8 has an implementation that receives and records the RFC 8707 `resource`, but it could not be confirmed that the REST API validates the audience of a token.
If an MCP client were given a Mattermost token directly, that MCP client could call all of Mattermost's APIs as the user.

So the MCP server takes on two roles.

1. **Authorization server for MCP clients**: it handles MCP client registration (Dynamic Client Registration), authorization and token issuance itself. The tokens it issues are addressed to the MCP server and cannot be used with Mattermost's API
2. **OAuth client of Mattermost**: it registers with Mattermost as just one confidential client and leaves the user's login to Mattermost's authorization screen. It stores the Mattermost tokens it obtains on the server side, encrypted, and does not hand them to MCP clients

```text
MCP client ──(MCP token)──> MCP server ──(Mattermost token)──> Mattermost API
       │                                   │
       └─ Authorization: the MCP server's /authorize ──> consent screen ──> Mattermost's /oauth/authorize (login)
```

### URLs and metadata

`/.well-known/oauth-authorization-server` directly under the domain is used by Mattermost's own metadata, so the MCP server's authorization server includes a path in its issuer and publishes its metadata in the path-insertion form of RFC 8414.

| Item | Value |
|---|---|
| MCP endpoint (resource) | `https://mattermost.example.com/mcp` (no trailing slash) |
| Protected Resource Metadata (RFC 9728) | `https://mattermost.example.com/.well-known/oauth-protected-resource/mcp` |
| Authorization server issuer | `https://mattermost.example.com/mcp` |
| Authorization Server Metadata | `https://mattermost.example.com/.well-known/oauth-authorization-server/mcp` |
| Endpoints for authorization, tokens, registration, the callback from Mattermost and so on | Under `https://mattermost.example.com/mcp/oauth/`. The implementer decides the concrete paths |

The metadata must include the following.

- Protected Resource Metadata: `resource` must exactly match the URL of the MCP endpoint (claude.ai requires an exact match including the path). `authorization_servers` is just the one issuer
- Authorization Server Metadata: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]` (clients registered through DCR are public clients), `scopes_supported: ["mattermost"]`
- Also put `scopes_supported: ["mattermost"]` in the Protected Resource Metadata, and add `scope="mattermost"` to the `WWW-Authenticate` of the `401`

There is only one scope, `mattermost`, which means "use the tools as this user's Mattermost account".
Scopes are not split between reading and writing. Confirmation before a write is left to MCP clients that look at the tool annotation (`readOnlyHint`) ([Tools](#tools)).

- When `scope` is omitted from an authorization request, `mattermost` is given. If any scope other than `mattermost` is included, the request is rejected with `invalid_scope`
- The scope is bound to the authorization code, the grant, the access token and the refresh token, so that it cannot be widened by a refresh

The `resource` parameter is required in authorization requests and token requests, and is rejected with `invalid_target` if it is missing or does not exactly match the URL of the MCP endpoint.
The authorization codes and tokens issued can be used only for this one resource.
All three target clients send `resource` in the authorization request and the code exchange (["Client compatibility"](../../measurements.md#client-compatibility) in `docs/measurements.md`).

This form follows the discovery procedures of RFC 8414 and the MCP specification, and it was confirmed by measurement that the three clients can find metadata in this form and connect (["Client compatibility"](../../measurements.md#client-compatibility) in `docs/measurements.md`).

### Authorization flow

1. When an MCP client accesses `/mcp` without a token, the MCP server returns `401` and `WWW-Authenticate: Bearer resource_metadata="…"`
2. The MCP client learns the authorization server from the Protected Resource Metadata and fetches the Authorization Server Metadata
3. The MCP client registers itself with DCR (RFC 7591)
4. The MCP client sends the user to the MCP server's authorization endpoint with PKCE (`S256` required). The MCP server validates `client_id`, `redirect_uri`, PKCE and `resource`
5. The MCP server shows a consent screen
6. When the user allows it, the MCP server redirects to Mattermost's `/oauth/authorize`. For this authorization from the MCP server to Mattermost too, it attaches a PKCE (`S256`) generated separately from the MCP client's
7. The user logs in to Mattermost and allows it
8. When Mattermost returns to the callback, the MCP server checks `state`, obtains and stores the Mattermost tokens, and returns an authorization code to the MCP client
9. The MCP client exchanges the authorization code for MCP tokens (an access token and a refresh token) at the MCP server's token endpoint

### Authorization codes issued to MCP clients

To meet the authorization code requirements of OAuth 2.1 (draft-13 §4.1.2–4.1.3), the following is observed.

- The authorization code is a random value of sufficient length, and only its hash is stored on the server side. Its lifetime is about 1 minute
- The Mattermost user, `client_id`, the `redirect_uri` of the authorization request, the PKCE `code_challenge` (`S256`) and `resource` are bound to the authorization code and stored
- In a token request, it is checked that `client_id` and `redirect_uri` match the stored values and that `code_verifier` matches `code_challenge`. If any one does not match, the request is rejected with `invalid_grant`. A missing or mismatching `resource` is rejected with `invalid_target`
- Consuming the authorization code and issuing the tokens are done in a single transaction, so the same code cannot be used twice. If a used code is presented again, the tokens issued from that code are revoked
- The `state` received from the MCP client is stored separately from the `state` sent to Mattermost, and is returned to the MCP client unchanged, on success and on error alike

### Consent screen

The OAuth app on the Mattermost side is a single fixed client ID, and anyone can register a client with DCR.
Without a consent screen, a confused deputy attack succeeds in which the authorization of a user already logged in to Mattermost flows automatically to the redirect destination of a client the attacker registered.
Following the MCP Security Best Practices, the consent screen satisfies the following.

- It is always shown for every authorization request, before redirecting to Mattermost. It is not skipped by remembering consent, because the user authorizes only when adding a client, so showing it every time is no burden
- It shows the client name, the whole of the registered redirect URI, and the requested permission (the meaning of the scope `mattermost`: "read and write messages as your Mattermost account"). The client name can be set freely by the registrant, so the redirect URI is made more prominent than the name
- For a client whose redirect URI is a loopback (`localhost`, `127.0.0.1`), an additional warning is shown that says "this hands permissions to an app on this machine; allow it only if you yourself started connecting Claude Code or Codex" (Localhost Redirect URI Risks of MCP 2025-11-25)
- The allow form carries a CSRF token. The response carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so that other sites cannot embed it in an iframe
- The `state` sent to Mattermost is generated at the moment the user allows. The server-side record of the authorization in progress stores together the browser cookie, the `state` and PKCE sent to Mattermost, and the MCP client's `client_id`, `redirect_uri`, PKCE, `state` and `resource`. This record can be used only once and expires in about 10 minutes. At the callback, the request is rejected unless the `state` and the cookie match the record
- The client name and redirect URI registered with DCR are treated as untrusted values the registrant decided freely
  - Upper limits on length are set at registration, and values containing control characters are rejected
  - On the consent screen and error pages they are shown only through an auto-escaping template or as text nodes, and are never interpreted as HTML
  - External resources such as DCR's `logo_uri` are not loaded
  - Next to the client name, "the name is self-declared by the registrant and has not been verified" is shown
- The responses of the consent screen and error pages carry the equivalent of `Content-Security-Policy: default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, so that no script runs at all. The consent screen is an HTML form that works without scripts
- An automated test checks that, when a client is registered with a malicious client name or redirect URI (an HTML tag, control characters, an extremely long value), no script runs on the consent screen and the display is not broken
- The cookie has a name starting with `__Host-`, carries `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`, and has no `Domain` (the Confused Deputy countermeasure of the MCP Security Best Practices). Its value is a random session ID, and the contents are held on the server side

### Redirect URIs

The redirect URIs accepted for registration with DCR are limited to the following.
A registration request that matches none of them is rejected with `invalid_redirect_uri`.

- `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback` (claude.ai and the desktop app. The current [Authentication for connectors](https://claude.com/docs/connectors/building/authentication#callback-urls) specifies only the `claude.ai` one, but Anthropic's old help center article (no longer published) recommended allowing both, because the callback might change to the `claude.com` side in the future. Adding one more Anthropic-managed domain with an exact match costs little, so both are allowed)
- Loopback (`http://localhost:<any port>/<any path>`, `http://127.0.0.1:<any port>/<any path>`) (Claude Code, Codex CLI)

Allowed patterns can be added through an environment variable.

The `redirect_uri` of an authorization request must exactly match a URI registered for that `client_id`.
The only exception is the port number of a loopback (RFC 8252, RFC 9700); the scheme, host, path and query must match.
When the `client_id` is unknown or the `redirect_uri` does not match, the error is not returned by redirect, and the MCP server's own error page is shown.

### MCP tokens

- The access token is short-lived (about 1 hour). The refresh token expires about 90 days after it was last used, and each rotation extends the expiry. There is no absolute expiry from issuance. As long as the user keeps using it, no re-login is needed, and only a user who did not use it for 90 days logs in again. The implementer decides the exact values
- Tokens are random opaque strings, and only their hashes are stored on the server side
- Refresh tokens are rotated (RFC 9700 §4.14.2). The series of tokens that continues from one authorization (a grant) is recorded, and a refresh records the used token and issues the new token in a single transaction. If a used refresh token is presented again, it is regarded as stolen, and all the access tokens and refresh tokens of that grant are revoked
- When the user revokes the MCP server's app from Mattermost's "Settings > Security > OAuth 2.0 Apps", all of that user's grants are revoked by the flow described below

### Mattermost tokens

Mattermost gives only one set of tokens to a pair of user and app, so the Mattermost tokens are stored as just one set per Mattermost user, and referenced from all of that user's grants.
If a copy were kept for each MCP client, the other copies would become invalid the moment any one of them refreshed.

- The access token and refresh token are stored encrypted with a key passed through an environment variable. Changing the key makes the stored tokens unreadable, and everyone logs in again
- When Mattermost's API returns `401`, the latest stored token is read again first. If another request has already refreshed, the request is retried once with that token
- Refreshing is done one at a time per user (requests that arrive at the same time wait for the result of one refresh). The new access token and refresh token are written in a single transaction
- Only when Mattermost returns `invalid_grant` to a refresh, or when the user has been deactivated, are that user's Mattermost tokens and MCP grants all revoked, and `401` is returned to the MCP client to prompt a re-login
- Mattermost rejects a request with an invalid session with `401` before calling the API handler (`web/handlers.go` in v11.7). So if a single call has received only `401`, it is treated as having made Mattermost process nothing. Even when a re-login becomes necessary, a post or an upload is "not sent", not "unknown whether sent". If a response other than `401` was received even once, or if the connection was lost after it was established, it is treated as possibly processed. This assumption does not hold for APIs where the server itself returns `401` (`deleteChannel`, `deleteUser` and so on), so review it when using them
- On temporary failures such as timeouts, connection failures and `5xx`, the stored information is left unchanged and a temporary tool error is returned

### Storage

The MCP server runs as just one process, so storage is a SQLite file placed on a volume.
What is stored is the registered MCP clients, the state of authorizations in progress, MCP grants and tokens, Mattermost tokens, the records for preventing duplicate `send_message` posts, and scheduled posts.

Of these, the DCR registration is done by each client just once per connection, and the `client_id` obtained is used from then on.
If the registration disappears, that client gets `invalid_client` and does not recover by logging in again (the connector has to be deleted and added again).
On the other hand, the DCR registration endpoint is public without authentication, so a third party can pile up registrations.
So registrations are handled in two kinds.

- **Authorized registrations** (registrations for which a user has completed authorization at least once): never deleted automatically. Authorization needs a Mattermost account, so a third party cannot increase them, and no limit is set on the total
- **Unauthorized registrations**: given a dedicated limit (a few hundred) and a lifetime (about 7 days). Those past the lifetime are deleted. When the limit is reached, a new registration is not rejected; the oldest unauthorized registration is deleted to make room. Even if a third party piles up registrations, legitimate users can still newly connect
- A client whose unauthorized registration was deleted is limited to cases such as leaving it for 7 days or more after starting authorization, and in that case the connector is added again
- A per-IP rate limit is also applied to the registration endpoint ("Limiting the load on Mattermost"). A warning log is written when unauthorized registrations approach the limit

No backup mechanism dedicated to the MCP server is provided.
The directory of the SQLite file and the encryption key are included in the deployment site's backup (a file copy or a disk snapshot).
If the SQLite file is lost, the SQLite file is restored from the latest backup by the following procedure, and the DCR registrations are brought back.
Clients registered after the backup do not come back, so those users are asked to add the connector again.

Restoring from an old backup puts the records of used refresh tokens and revoked grants back to a past state, and rotated old tokens may become valid again.
So restoring from a backup is limited to the following procedure.

1. Before starting the MCP server with the restored SQLite file, run the MCP server image's admin command in a standalone container with no network (mounting the whole directory, including SQLite's `-wal` and `-shm`) (`docker run --rm --network none -v <SQLite directory>:/data <image> <delete command>`), and delete all of the state of authorizations in progress, authorization codes, grants, MCP tokens, Mattermost tokens and the records for preventing duplicate `send_message` posts. The registered MCP clients (DCR registrations) are not deleted
   Then fail all waiting and posting scheduled posts ("Restore" in [Scheduled posts](#scheduled-posts))
2. Only after that, start the MCP server. When restoring in a form where the MCP server starts automatically on restore, such as a disk snapshot, finish step 1 before the automatic start, so that there is no route by which requests can reach the rolled-back MCP server

Because the DCR registrations are kept, each client does not need to add the connector again, and recovers just by the usual re-login after the refresh token it holds is rejected with `invalid_grant`.
DCR registrations hold no user permissions, so there is no real harm if they are rolled back.
The encryption key is not regenerated. The Mattermost tokens are deleted, but the bodies of the scheduled posts that were failed stay encrypted with the same key for 7 days from the update, and regenerating the key would make the bodies unreadable in the list.
This procedure is written in the operations manual (`docs/operations.md`).

The approach of adding a DB to Mattermost's PostgreSQL is not adopted.
It would share Mattermost's DB and its operations (dump, restore, major version updates), and we do not want to create situations where the MCP server's needs require touching Mattermost's DB.

### MCP transport

Streamable HTTP is provided at `/mcp`.
It is in stateless mode with no sessions, and notification subscriptions are not provided.
The old HTTP+SSE transport is not provided (all three target clients support Streamable HTTP).

Following the MCP Streamable HTTP specification, a request with an `Origin` header is rejected with `403` unless the origin is in an allowlist (by default `https://claude.ai` and `https://claude.com`, more can be added through an environment variable).
A request without an `Origin` header (from a CLI or server-to-server communication) is accepted with only bearer token validation.

