#!/bin/sh
# MATTERMOST_IMAGE_TAG を固定値に落とさない。更新後も古い版で黙ってテストが通るのを防ぐため、どこにもなければ失敗する。
set -eu
cd "$(dirname "$0")/.."
if [ -z "${MATTERMOST_IMAGE_TAG:-}" ]; then
  for f in ../mattermost-infra/compose/.env ../mattermost-infra/compose/env.example; do
    if [ -f "$f" ]; then
      MATTERMOST_IMAGE_TAG=$(sed -n 's/^MATTERMOST_IMAGE_TAG=//p' "$f" | head -n1)
      [ -n "$MATTERMOST_IMAGE_TAG" ] && break
    fi
  done
fi
: "${MATTERMOST_IMAGE_TAG:?MATTERMOST_IMAGE_TAG が環境変数にも ../mattermost-infra/compose/{.env,env.example} にもない}"
export MATTERMOST_IMAGE_TAG
exec docker compose -f dev/compose.yml "$@"
