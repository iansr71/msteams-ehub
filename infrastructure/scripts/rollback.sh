#!/usr/bin/env bash
# Rolls the API, the bot and the scheduled jobs back to an earlier image.
# Usage: rollback.sh <dev|test|prod> [--to-tag TAG] [--yes]
#
# Without --to-tag it uses the most recent image in the API's revision history that differs from
# the current one. Only the image changes: settings, secrets and the state on the file share stay as
# they are (docs/infrastructure.md, "Rollback"). The next deploy.sh run deploys whatever tag it
# is given, so pass the rolled-back tag (--image-tag) until the fix is released.
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ $# -ge 1 ]] || die "Usage: rollback.sh <dev|test|prod> [--to-tag TAG] [--yes]"
environment="$1"
shift
target_tag="" assume_yes="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to-tag) target_tag="${2:-}"; shift 2 ;;
    --yes) assume_yes="true"; shift ;;
    *) die "Unknown option $1" ;;
  esac
done

load_environment "$environment"
require_azure

registry_server="$(deployment_output "$EHUB_FOUNDATION_DEPLOYMENT" registryLoginServer)"
registry="$(deployment_output "$EHUB_FOUNDATION_DEPLOYMENT" registryName)"
api="$(deployment_output "$EHUB_APPS_DEPLOYMENT" apiAppName)"
bot="$(deployment_output "$EHUB_APPS_DEPLOYMENT" botAppName)"
[[ -n "$registry_server" && -n "$api" && -n "$bot" ]] || die "Deployment outputs not found for ${EHUB_ENV}."

current="$(az containerapp show --name "$api" --resource-group "$EHUB_RESOURCE_GROUP" \
  --query "properties.template.containers[0].image" -o tsv --only-show-errors)"

if [[ -n "$target_tag" ]]; then
  [[ "$target_tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "Invalid --to-tag."
  az acr repository show-tags --name "$registry" --repository ehub -o tsv --only-show-errors |
    grep -qx "$target_tag" || die "Tag ${target_tag} is not in ${registry}."
  target="${registry_server}/ehub:${target_tag}"
else
  # The most recent revision whose image differs from the current one (newest first). Earlier
  # rollbacks make the history non-monotonic (A, B, A), so this does not de-duplicate.
  target=""
  while IFS= read -r image; do
    [[ -z "$image" || "$image" == "$current" ]] && continue
    target="$image"
    break
  done < <(az containerapp revision list --name "$api" --resource-group "$EHUB_RESOURCE_GROUP" \
    --all --query "reverse(sort_by(@, &properties.createdTime))[].properties.template.containers[0].image" \
    -o tsv --only-show-errors)
  [[ -n "$target" ]] || die "No earlier image in the API's revision history; pass --to-tag."
fi
[[ "$target" != "$current" ]] || die "The API already runs ${target}."

info "Current: ${current}"
info "Target:  ${target}"
confirm_production "$assume_yes" "roll back"

for app in "$api" "$bot"; do
  az containerapp update --name "$app" --resource-group "$EHUB_RESOURCE_GROUP" \
    --image "$target" --only-show-errors -o none
  info "Rolled back ${app}."
done
while IFS= read -r job; do
  [[ -z "$job" ]] && continue
  az containerapp job update --name "$job" --resource-group "$EHUB_RESOURCE_GROUP" \
    --image "$target" --only-show-errors -o none
  info "Rolled back ${job}."
done < <(az containerapp job list --resource-group "$EHUB_RESOURCE_GROUP" \
  --query "[?starts_with(name, 'caj-${EHUB_NAME_PREFIX}-${EHUB_ENV}-')].name" -o tsv --only-show-errors)

info "Done. Check: curl -fsS $(deployment_output "$EHUB_APPS_DEPLOYMENT" apiUrl)/health/ready"
info "Deploy with --image-tag ${target##*:} until the fix is released."
