# Operations

How to keep a deployed MCP server running.
For deployment, see [deployment.md](deployment.md).
The commands assume the `compose.yml` example in [deployment.md](deployment.md) (service name `mcp`).

## Post-deployment checks

With the operator's account, connect to `<PUBLIC_URL>/mcp` from each MCP client you plan to use (claude.ai, Claude Code, Codex CLI and so on).

- Call each of the 17 read tools (`search_posts`, `search_files`, `read_channel`, `read_thread`, `search_channels`, `search_users`, `get_user`, `get_post`, `get_file`, `list_saved_posts`, `list_my_channels`, `get_channel`, `list_channel_members`, `get_unreads`, `get_mentions`, `list_scheduled_messages`, `search_emoji`) once, and confirm none of them returns an error
  - `get_unreads` prints the CRT decision line at the top of its output (for example `Collapsed threads (CRT): on (Server setting: …)`)
  - If `search_files` returns "File search is turned off on this Mattermost", file search is disabled in the Mattermost System Console. Ask the Mattermost administrator to enable it if you want to use it
- Check per client that the image from `get_file` reaches the client. The integration tests do not use a client, so this is the only place to check it
  1. On the web, attach an image containing text to a post in the operator's own DM (`@<operator's username>`)
  2. Read `@<operator's username>` with `read_channel`, and confirm the post shows an `Attachment:` line (`file_id`, name, type, size, width and height)
  3. Call `get_file` with that `file_id`, and have the model read the text written in the image. Look separately at whether the image is shown on the client's screen and whether the model could answer what it contains
  4. When done, delete that post on the web
- Check the write tools only inside the operator's own DM. Do not touch posts in other channels or by other users
  1. Post to `@<operator's username>` with `send_message`
  2. Call `add_reaction` (for example `white_check_mark`) on that post and confirm on screen that it was added. Remove it with `remove_reaction` and confirm on screen that it is gone. Call `save_post` on the same post and confirm it appears under saved posts on screen, and call `pin_post` and confirm it appears under pinned posts on screen. Remove them with `unsave_post` and `unpin_post` and confirm on screen that they are gone
  3. Change the body with `edit_message` and confirm on screen that it changed. Delete it with `delete_message` and confirm on screen that it is gone
  4. Save a draft with `save_draft`, open the DM, and confirm it appears in the input box. Do not send it; empty the input box on screen to delete the draft
  5. Post with `send_message` and `files` (for example `{"name":"check.txt","content_text":"attachment check"}`), and confirm the attachment appears on screen. When confirmed, delete it with `delete_message`
  6. From a client that can run commands on the PC (Claude Code, Codex CLI and so on), issue a URL for `@<operator's username>` with `prepare_upload` and send an image of a few MB with `curl`. Pass the returned `file_id` to `file_ids` of `send_message` to post it, and confirm the attachment appears on screen. Also confirm that sending to the same URL again returns 404. When confirmed, delete it with `delete_message`
- Check scheduled messages only inside the operator's own DM. Make the bodies differ from the bodies sent in the other steps and from each other (with the same body, the matching on retry could mistake one post for another)
  1. Create 2 schedules with `schedule_message` for 2 to 3 minutes from now
  2. Move the time of one back by about 1 minute with `update_scheduled_message`, and cancel the other with `cancel_scheduled_message`
  3. After the changed time passes (the sweep runs every 30 seconds, so wait about 1 minute), confirm with `list_scheduled_messages` that the rescheduled message is "posted" and that its permalink opens that post. The cancelled schedule does not appear in the list
  4. Confirm that only 1 post of the scheduled message appears on the DM screen. When confirmed, delete that post on the web
- Check marking as read only inside the operator's own DM
  1. Post 2 messages to `@<operator's username>` with `send_message`, and on the web put the first back to unread with "Mark as Unread"
  2. Read `@<operator's username>` with `read_channel` and `from: "unread"`, and confirm the posts appear oldest first, starting from the one put back to unread
  3. Call `mark_as_read` with the `post_id` of the newest of those posts as `last_post_id`, and confirm the unread mark on screen is gone. When confirmed, delete the 2 posts with `delete_message`
- Check thread following only inside the operator's own DM. If the CRT decision line of `get_unreads` says off, only confirm that `list_followed_threads` returns "Collapsed threads (CRT) are off" and skip the rest
  1. Post to `@<operator's username>` with `send_message`, then post 1 reply with that `post_id` as `root_id`
  2. Call `list_followed_threads` and confirm the thread appears (Mattermost follows a thread you replied to automatically)
  3. Call `unfollow_thread` and confirm it disappears from `list_followed_threads`. Call `follow_thread` and confirm it comes back
  4. When confirmed, delete the reply and then the parent post with `delete_message` (a parent post with replies cannot be deleted)
- Check presence and the custom status with the operator's own status. Do not check while the status is out of office (ooo) or do not disturb (when you change from out of office, Mattermost stops the auto-reply and the MCP cannot restore it. If you set do not disturb again while already in do not disturb, do not disturb continues past the original end time)
  1. Before starting, read yourself with `get_user` and note the `Presence:` line (whether `(set manually)` is attached). Note the custom status on the web
  2. Call `set_status` with `dnd` and a `dnd_until` about 10 minutes ahead, and confirm that the presence on screen becomes do not disturb. Read yourself with `get_user` and also confirm that `do not disturb (until: …)` appears
  3. Specify an emoji (for example `calendar`), text, and an `until` 1 hour ahead with `set_custom_status`, and confirm it appears as the custom status on screen. Clear it with `clear_custom_status` and confirm it is gone from the screen
  4. Return to the noted presence with `set_status` (`online` if `(set manually)` was not attached). If there was a custom status, set it again on the web. Remove the ones used for the check from the "Recent" list of the custom status on the web
- Revocation and re-login
  1. In Mattermost under "Settings > Security > OAuth 2.0 Apps", revoke the authorization of the OAuth app you created
  2. The next tool call returns "You need to log in to Mattermost again. Reconnect the connector."
  3. On the request after that, the client asks for a re-login, and once you log in again you can call the tools
- The logs ("Logs" below) show the `tool_call` of the calls above, `scheduled_post` of the schedules and `upload` of the uploads, and contain no post bodies, search terms, tokens (`Bearer`, `access_token`, `refresh_token`, the token in an upload URL) or attachment file names and contents

## Logs

The server writes one JSON object per line to standard output.
Each line has `ts` (time) and `event`.
Post bodies, search terms and tokens are not logged.

```bash
docker compose logs --no-log-prefix mcp | grep '"event":"tool_call"'
```

| `event` | Content |
|---|---|
| `tool_call` | A tool call. `mm_user_id`, `tool`, `outcome` (`ok`, `tool_error`, `input_error`, `invalid_args` (the MCP SDK rejected arguments that do not match the inputSchema before calling the tool: arguments it does not accept, wrong type, format, length or range, and missing required ones. `input_error` is for input that matches the schema but that the tool rejected during processing), `reauthorize`, `rate_limited`, `upstream_unavailable`, `mm_error`, `error`), `ms` |
| `tool_interrupted` | `mark_as_read` was interrupted midway by a re-login, a 429, a Mattermost outage or the like, and returned the results so far as a tool error. `mm_user_id`, `tool`, `outcome` (the cause of the interruption. The same values as `outcome` of `tool_call`. In this case `outcome` of `tool_call` is `tool_error`) |
| `scheduled_post` | The result of posting a schedule. `mm_user_id`, `outcome` |
| `upload` | An upload to the `prepare_upload` URL. `mm_user_id`, `outcome` (`ok`, `too_large`, `client_gone` (the connection dropped midway through the body), `stalled` (no data arrived for 15 seconds while waiting for the body), `InputError`, `MmError`, `RateLimited`, `UpstreamUnavailable` and so on), `files` (the number sent to Mattermost), `bytes` (the total of the received files), `ms`. It is not logged when the URL is invalid or when the number of concurrent uploads is exceeded |
| `draft_cleanup_failed` | A failure to check or delete a draft with the same body after the post of `send_message`. The post succeeded. `mm_user_id`, `channel_id`, `name` (the error name), and `status` and `id` for a Mattermost error. `name` is mainly `TimeoutError` (a deadline; it stopped while waiting for a lock or a rate limit slot, or before sending the delete), `UpstreamUnavailable` (Mattermost could not be reached, returned a `5xx` other than `501`, the token refresh failed, or the call was cut off midway), `MmError` (an error response from Mattermost: a `4xx` other than `401` and `429`, or `501`), `Reauthorize` (a re-login is needed) and `RateLimited` (the rate limit of Mattermost or of this server). A deadline can show up as either `TimeoutError` or `UpstreamUnavailable`, so the name does not tell you whether it was a deadline. If `skipped` is `delete`, the delete was not sent because too little time was left before the deadline, and the draft remains. If there is no `skipped`, it failed or hit the deadline somewhere in waiting for the lock or rate limit, the check or the delete, so check the draft list to see whether it was deleted. It is not logged when draft sync is disabled on the server or when the client cancelled the request |
| `token_issued`, `token_refreshed` | Issue and refresh of MCP tokens. `client_id`, `mm_user_id` |
| `token_reuse_detected` | A used authorization code or refresh token was presented again, and that grant was revoked. `client_id`. That client has to log in again. If it repeats for the same client, suspect a token leak or that the client is sending the same refresh token concurrently |
| `mm_refresh_config_error` | Mattermost rejected a refresh with a 4xx other than those a re-login fixes. `status`, `id`. With `model.oauth.validate_grant.credentials.app_error` (401), `MM_OAUTH_CLIENT_SECRET` does not match the OAuth app (for example after regenerating the secret). Tools keep returning a temporary error |
| `dcr_registered`, `dcr_unauthorized_near_limit` | A client registration, and a warning that unauthorized registrations are near the limit ("When unauthorized registrations near the limit" below) |
| `authorize_completed`, `authorize_upstream_failed` | A user's login completing, and a communication failure with Mattermost (`step` is `exchange` or `users_me`) |
| `unhandled_error`, `tool_unhandled_error`, `upload_unhandled_error`, `scheduled_post_error`, `scheduler_failed`, `sweep_failed` | Unexpected failures. They carry only the error name and code |
| `listening`, `shutting_down` | Start and stop. `listening` has `port`, `locale` and `time_zone` |

### Mattermost server log

The Mattermost server log can show a warning `error getting channel id by name from in filter`.
`search_posts` and `search_files` replace the channel specified with `in:` (including `-in:` and `channel:`) with the channel_id before passing it on, but Mattermost first looks that value up as a channel name, and when the lookup fails it logs this warning and uses the ID as it is in the condition.
The search results are correct and this is not a bug in the MCP server, so no action is needed.
One search logs one line per replaced value (channel ID), or two lines when ordinary terms and hashtags are mixed.

## Admin commands

Run `node src/admin.ts` inside the container.
It does not need `TOKEN_ENC_KEY`, and operates directly on the DB at `DB_PATH` (default `/data/mcp.sqlite`).

```bash
docker compose exec mcp node src/admin.ts list-clients               # registered MCP clients (client_id, name, registration time, whether authorized)
docker compose exec mcp node src/admin.ts list-clients --unauthorized # only unauthorized registrations
docker compose exec mcp node src/admin.ts delete-client <client_id>   # deletes a registration. That client has to add the connector again
docker compose exec mcp node src/admin.ts purge-credentials          # deletes in-progress authorization state, grants, tokens, upload URLs and duplicate-prevention records. Registrations are kept
```

Running `purge-credentials` on a live server makes every user log in again.
Normally use it only when restoring from a backup, and then also run `invalidate-scheduled`.
`invalidate-scheduled` fails every waiting and posting schedule, and keeps posted and failed schedules.
In a restore, run both `purge-credentials` and `invalidate-scheduled` in a standalone container before starting the MCP server ("Backup and restore" below).
Do not run `invalidate-scheduled` on a live server. It also fails a schedule the sweep is posting at that moment, so the post has arrived but the list shows a failure whose reason says "It is unknown whether this was posted", and if the user re-enters it without checking, the same post goes out twice.
The wording of the failure reason is also written for the restore case.

## When unauthorized registrations near the limit

Unauthorized registrations (registered through DCR but never completed by a user's authorization) are deleted after 7 days, and beyond the limit of 500 the oldest are deleted first.
Above 450, `dcr_unauthorized_near_limit` (`count` is the number) is logged.

```bash
docker compose exec mcp node src/admin.ts list-clients --unauthorized | wc -l
docker compose exec mcp node src/admin.ts list-clients --unauthorized | cut -f2,3 | tail -20
```

- Legitimate use never piles up several hundred unauthorized registrations (even claude.ai makes 2 per connection; [Client compatibility in measurements.md](measurements.md#client-compatibility)). If registrations with matching names and times appear in a cluster, treat it as a third party piling them up
- At the limit the oldest unauthorized registration is deleted first, so new connections from legitimate users are not blocked. Authorized registrations are not deleted automatically
- Aggregate the source of `POST /mcp/oauth/register` in the reverse proxy access log, and keep a record if it is skewed. Keep a per-IP rate limit on the registration endpoint ([Reverse proxy in deployment.md](deployment.md#5-reverse-proxy))

## When updating Mattermost

The MCP server relies on the OAuth behavior measured on Mattermost 11.7.15 ([measurements.md](measurements.md)) and on the undocumented deduplication by `pending_post_id`.
Before updating, pass the integration tests against the new version on a development machine.

```bash
pnpm dev:down
MATTERMOST_IMAGE_TAG=<new version> pnpm dev:up
pnpm test:int
```

Update the production Mattermost only after they pass.
If they fail, stop the update and investigate the behavior that differs.

## When updating the MCP server

Before updating, copy `/data` as described in "Backup and restore" below.
Build the new version and recreate the container (`docker compose up -d --build mcp`).

The DB schema is created with `CREATE TABLE IF NOT EXISTS` on every start, and then the columns listed in `migrate` in `src/db.ts` are added to existing tables if missing.
`migrate` handles only the addition of columns. A new table in a new version is added by `CREATE TABLE`, but changes or deletions of existing columns are not applied to an existing DB.
Before updating, look at the diff of `src/db.ts`, and if existing tables change beyond the columns `migrate` adds, do not update to that version unless a migration procedure is given.

Before upgrading to a version where the language and the time zone are chosen with the environment variables `LOCALE` and `TIME_ZONE`, a deployment that runs in Japanese and JST adds `LOCALE=ja` and `TIME_ZONE=Asia/Tokyo` to its environment variables.
The defaults are `en` and `UTC`, so if you upgrade without adding them, tool output becomes English and times without an offset are read as UTC.
After updating, confirm that `locale` and `time_zone` in the `listening` startup log are the values you added.

To roll back, restore the previous version's image together with the `/data` you copied before the update.

## Backup and restore

The MCP server's state lives only in the SQLite files in `/data` (`mcp.sqlite`, `-wal`, `-shm`) and in `TOKEN_ENC_KEY`.
Take a backup by stopping the container and copying the whole directory, or with a snapshot of the disk that contains the directory.
Keep the key separately from the SQLite files.

If you start an old backup as it is, used refresh tokens and revoked grants return to their past state, and old tokens that have already been rotated can become valid again.
Schedules that were cancelled or changed afterwards also come back as waiting and get posted.
So before starting a restored SQLite file as the MCP server, delete the credentials and fail the schedules in a container with no network.

```bash
docker compose stop mcp
# Put the restored files in ./data, set the owner to UID 1000, and make them unreadable to other users
sudo chown -R 1000:1000 data && sudo chmod 700 data
docker run --rm --network none -v "$PWD/data:/data" mcp-server-for-mattermost node src/admin.ts list-clients | wc -l
docker run --rm --network none -v "$PWD/data:/data" mcp-server-for-mattermost node src/admin.ts purge-credentials
docker run --rm --network none -v "$PWD/data:/data" mcp-server-for-mattermost node src/admin.ts invalidate-scheduled
docker run --rm --network none -v "$PWD/data:/data" mcp-server-for-mattermost node src/admin.ts list-clients | wc -l
docker compose up -d mcp
```

- `purge-credentials` prints `purged <count> rows`. Confirm the count of `list-clients` before and after does not change (DCR registrations are not deleted). Registrations remain, so each client returns through a normal re-login after its local refresh token is rejected with `invalid_grant`
- `invalidate-scheduled` prints `invalidated <count> scheduled posts`. The schedules it failed appear in `list_scheduled_messages` with a reason, so if the count is not 0, tell users to check their schedules and enter them again. A schedule that was attempted and a schedule past its scheduled time get a reason saying "It is unknown whether this was posted" (it may have been posted after the backup)
- Run the admin commands not with `docker compose exec` but in a standalone container that does not start the MCP server, with no network. The image name is the one set in the `compose.yml` example in [deployment.md](deployment.md#4-start)
- Do not regenerate the key (`TOKEN_ENC_KEY`). The bodies of the failed schedules stay encrypted with the same key for 7 days after the update, and regenerating it makes the bodies unreadable in `list_scheduled_messages`
- Clients registered after the backup do not come back, so ask those users to add the connector again
- When you start from the restored disk as a whole (for example booting from a VM snapshot), finish the steps above before the MCP server container starts automatically. This keeps the rolled-back MCP server unreachable from anywhere

If you lose the SQLite files and have no backup, restart with an empty `/data`.
All registrations, logins and schedules are lost, and users add the connector again.
Tell the users who had schedules that the schedules were lost.

## Incident response

### `mcp` keeps restarting

`docker compose ps mcp` stays at `Restarting` or never becomes `healthy`.
Even if the MCP server is down, Mattermost keeps running and only the MCP paths return 502.

```bash
docker compose ps mcp
docker compose logs --tail 50 mcp
```

| Log | Cause | Action |
|---|---|---|
| `... is required`, such as `PUBLIC_URL is required` | A required environment variable is missing | [Environment variables in deployment.md](deployment.md#3-environment-variables) |
| `PUBLIC_URL must not end with a slash` | A trailing slash on `PUBLIC_URL` | Remove it |
| `TOKEN_ENC_KEY must be 32 bytes in base64` | The key format is wrong | Regenerate the key only when the DB holds neither Mattermost tokens nor waiting schedules. If it does, find the original key |
| `... must be a positive integer` | The value of `PORT` or `ACCESS_TOKEN_TTL_SEC` | Make it a positive integer |
| `unable to open database file` | `/data` does not exist, or UID 1000 cannot write to it | `ls -ln data`, `chown 1000:1000 data` |

After fixing it, recreate with `docker compose up -d mcp` (changes to environment variables take effect only when recreated).

### A tool returns "Cannot connect to Mattermost for the moment."

The MCP server cannot reach `MM_URL`.

```bash
docker compose exec mcp node -e "fetch(process.env.MM_URL+'/api/v4/system/ping').then(r=>console.log(r.status),e=>{console.error(e.cause?.code??e.message);process.exit(1)})"
```

If you omitted `MM_URL` and it equals `PUBLIC_URL`, substitute `PUBLIC_URL` when typing it.
If the result is anything but 200, check name resolution, the certificate, and the reverse proxy access restrictions (whether the MCP server's source address is rejected).
While the reverse proxy temporarily restricts access to the operator only, calls from the MCP server to Mattermost are under the same restriction, so the MCP is unusable too.
