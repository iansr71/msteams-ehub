#!/usr/bin/env bash
# Validates and builds the Teams app package for an environment, and optionally uploads it to
# the environment's `releases` container.
# Usage: package-teams-app.sh <dev|test|prod> [--upload]
#
# Needs in the .env file: EHUB_TEAMS_APP_ID, EHUB_TEAMS_DEVELOPER_NAME, EHUB_TEAMS_WEBSITE_URL,
# EHUB_TEAMS_PRIVACY_URL, EHUB_TEAMS_TERMS_URL (and EHUB_BOT_CLIENT_ID).
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ $# -ge 1 ]] || die "Usage: package-teams-app.sh <dev|test|prod> [--upload]"
environment="$1"
upload="false"
[[ "${2:-}" == "--upload" ]] && upload="true"

load_environment "$environment"
require_guid EHUB_TEAMS_APP_ID
for name in EHUB_TEAMS_WEBSITE_URL EHUB_TEAMS_PRIVACY_URL EHUB_TEAMS_TERMS_URL; do
  require_https_url "$name"
done
require_value EHUB_TEAMS_DEVELOPER_NAME

# Every environment deployed here uses real Entra sign-in, so the package is built with the
# production manifest rules.
export TEAMS_APP_ID="$EHUB_TEAMS_APP_ID"
export TEAMS_BOT_CLIENT_ID="$EHUB_BOT_CLIENT_ID"
export TEAMS_DEVELOPER_NAME="$EHUB_TEAMS_DEVELOPER_NAME"
export TEAMS_WEBSITE_URL="$EHUB_TEAMS_WEBSITE_URL"
export TEAMS_PRIVACY_URL="$EHUB_TEAMS_PRIVACY_URL"
export TEAMS_TERMS_URL="$EHUB_TEAMS_TERMS_URL"
[[ -z "${EHUB_TEAMS_SSO_RESOURCE:-}" ]] || export TEAMS_SSO_RESOURCE="$EHUB_TEAMS_SSO_RESOURCE"

cd "$EHUB_REPO_ROOT"
pnpm --silent teams:validate --env production
output="$(pnpm --silent teams:package --env production)"
printf '%s\n' "$output"
package="$(sed -n 's/^Package written: //p' <<<"$output" | tail -n 1)"
[[ -n "$package" && -f "$package" ]] || die "The package was not written."
info "SHA-256: $(sha256sum "$package" | cut -d' ' -f1)"

if [[ "$upload" == "true" ]]; then
  require_azure
  storage="$(deployment_output "$EHUB_FOUNDATION_DEPLOYMENT" storageAccountName)"
  [[ -n "$storage" ]] || die "Stage 1 outputs not found."
  blob="teams/${EHUB_ENV}/$(basename "$package")"
  # No --overwrite: a published version number is never replaced.
  az storage blob upload --account-name "$storage" --container-name releases --name "$blob" \
    --file "$package" --auth-mode login --only-show-errors -o none
  info "Uploaded to ${storage}/releases/${blob}"
fi
