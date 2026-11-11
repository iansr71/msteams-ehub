#!/usr/bin/env bash
# Shows what a deployment would change, without changing anything.
# Usage: what-if.sh <dev|test|prod> [--stage foundation|apps] [--image-tag TAG]
# For the apps stage the tag defaults to the image the API runs now, so only template changes show.
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ $# -ge 1 ]] || die "Usage: what-if.sh <dev|test|prod> [--stage foundation|apps] [--image-tag TAG]"
environment="$1"
shift
stage="foundation" tag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) stage="${2:-}"; shift 2 ;;
    --image-tag) tag="${2:-}"; shift 2 ;;
    *) die "Unknown option $1" ;;
  esac
done
[[ "$stage" =~ ^(foundation|apps)$ ]] || die "--stage must be foundation or apps."

load_environment "$environment"
require_azure

deploy_apps="false"
if [[ "$stage" == "apps" ]]; then
  deploy_apps="true"
  if [[ -z "$tag" ]]; then
    api="$(deployment_output "$EHUB_APPS_DEPLOYMENT" apiAppName 2>/dev/null || true)"
    [[ -n "$api" ]] || die "No apps deployment yet: pass --image-tag."
    image="$(az containerapp show --name "$api" --resource-group "$EHUB_RESOURCE_GROUP" \
      --query "properties.template.containers[0].image" -o tsv --only-show-errors)"
    tag="${image##*:}"
  fi
fi

EHUB_DEPLOY_APPS="$deploy_apps" EHUB_IMAGE_TAG="$tag" az deployment group what-if \
  --resource-group "$EHUB_RESOURCE_GROUP" --parameters "$EHUB_PARAMS_FILE" \
  --result-format FullResourcePayloads --only-show-errors
