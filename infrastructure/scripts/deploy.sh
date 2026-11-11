#!/usr/bin/env bash
# Deploys one environment in two stages (docs/infrastructure.md):
#   1. foundation: monitoring, Key Vault, Search, Storage, registry, identities, roles, network,
#      Container Apps environment;
#   2. apps: builds the image in the registry, checks the operator secrets, then deploys the
#      API, bot, jobs, Azure Bot registration and availability tests.
#
# Usage: deploy.sh <dev|test|prod> [--stage all|foundation|apps] [--image-tag TAG]
#                  [--skip-build] [--allow-dirty] [--yes]
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  info "Usage: deploy.sh <dev|test|prod> [--stage all|foundation|apps] [--image-tag TAG] [--skip-build] [--allow-dirty] [--yes]"
  exit 2
}

[[ $# -ge 1 ]] || usage
environment="$1"
shift
stage="all" tag="" skip_build="false" allow_dirty="false" assume_yes="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage) stage="${2:-}"; shift 2 ;;
    --image-tag) tag="${2:-}"; shift 2 ;;
    --skip-build) skip_build="true"; shift ;;
    --allow-dirty) allow_dirty="true"; shift ;;
    --yes) assume_yes="true"; shift ;;
    *) usage ;;
  esac
done
[[ "$stage" =~ ^(all|foundation|apps)$ ]] || usage
[[ -z "$tag" || "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "Invalid --image-tag."

load_environment "$environment"
require_azure
confirm_production "$assume_yes" "deploy to"

deploy_foundation() {
  info "Stage 1: foundation (${EHUB_RESOURCE_GROUP}, ${EHUB_LOCATION})."
  az group create --name "$EHUB_RESOURCE_GROUP" --location "$EHUB_LOCATION" \
    --tags application=ehub-knowledge-assistant environment="$EHUB_ENV" \
    --only-show-errors -o none
  EHUB_DEPLOY_APPS=false EHUB_IMAGE_TAG="" az deployment group create \
    --resource-group "$EHUB_RESOURCE_GROUP" --name "$EHUB_FOUNDATION_DEPLOYMENT" \
    --parameters "$EHUB_PARAMS_FILE" --only-show-errors -o none
  info "Foundation deployed."
}

missing_secrets() {
  local vault="$1" names
  # Listing needs data-plane access (Key Vault Secrets Officer from stage 1). A fresh role
  # assignment can take a few minutes to apply.
  names="$(az keyvault secret list --vault-name "$vault" --query "[].name" -o tsv --only-show-errors)" ||
    die "Cannot list secrets in ${vault}. If stage 1 just granted you access, wait a few minutes and run --stage apps."
  local secret
  for secret in moodle-token teams-bot-client-secret; do
    grep -qx "$secret" <<<"$names" || printf '%s\n' "$secret"
  done
}

deploy_apps() {
  local registry vault
  registry="$(deployment_output "$EHUB_FOUNDATION_DEPLOYMENT" registryName)"
  vault="$(deployment_output "$EHUB_FOUNDATION_DEPLOYMENT" keyVaultName)"
  [[ -n "$registry" && -n "$vault" ]] || die "Stage 1 outputs not found: run --stage foundation first."

  local missing
  missing="$(missing_secrets "$vault")"
  if [[ -n "$missing" ]]; then
    info "Key Vault ${vault} is missing: $(tr '\n' ' ' <<<"$missing")"
    info "Add each from a file so the value stays out of shell history, then delete the file:"
    info "  az keyvault secret set --vault-name ${vault} --name moodle-token --file moodle-token.txt"
    info "  az keyvault secret set --vault-name ${vault} --name teams-bot-client-secret --file bot-secret.txt"
    die "Secrets missing; nothing was deployed in stage 2."
  fi

  if [[ -z "$tag" ]]; then tag="$(image_tag "$allow_dirty")"; fi
  if [[ "$skip_build" == "true" ]]; then
    az acr repository show-tags --name "$registry" --repository ehub -o tsv --only-show-errors 2>/dev/null |
      grep -qx "$tag" || die "Image ehub:${tag} is not in ${registry}; build it or drop --skip-build."
  else
    info "Building ehub:${tag} in ${registry} (az acr build)."
    az acr build --registry "$registry" --image "ehub:${tag}" \
      --build-arg "NODE_IMAGE=${EHUB_NODE_IMAGE:-node:22-bookworm-slim}" \
      --file "${EHUB_REPO_ROOT}/Dockerfile" "$EHUB_REPO_ROOT" --only-show-errors -o none
  fi

  info "Stage 2: services with image ehub:${tag}."
  local attempt
  for attempt in 1 2; do
    if EHUB_DEPLOY_APPS=true EHUB_IMAGE_TAG="$tag" az deployment group create \
      --resource-group "$EHUB_RESOURCE_GROUP" --name "$EHUB_APPS_DEPLOYMENT" \
      --parameters "$EHUB_PARAMS_FILE" --only-show-errors -o none; then
      break
    fi
    # The per-secret role assignments are created in this same deployment; the services can
    # fail to read their Key Vault references until the assignments propagate.
    [[ "$attempt" == 1 ]] || die "Stage 2 failed twice. See the deployment in the portal: ${EHUB_APPS_DEPLOYMENT}."
    warn "Stage 2 failed; retrying in 90 seconds (role assignments can take time to apply)."
    sleep "${EHUB_RETRY_DELAY_SECONDS:-90}"
  done

  info "Deployed."
  info "  API:              $(deployment_output "$EHUB_APPS_DEPLOYMENT" apiUrl)"
  info "  Bot endpoint:     $(deployment_output "$EHUB_APPS_DEPLOYMENT" botMessagingEndpoint)"
  info "  Outbound IP:      $(deployment_output "$EHUB_APPS_DEPLOYMENT" outboundIp)"
  info "Next: configure-bot-sso.sh ${EHUB_ENV}, create the search index, run the first sync (docs/infrastructure.md)."
}

case "$stage" in
  foundation) deploy_foundation ;;
  apps) deploy_apps ;;
  all)
    deploy_foundation
    deploy_apps
    ;;
esac
