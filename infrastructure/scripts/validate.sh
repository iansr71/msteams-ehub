#!/usr/bin/env bash
# Validates the Bicep templates without changing anything.
#   validate.sh                   lint and build every template; build every parameter file with
#                                 placeholder values (what the repository checks run)
#   validate.sh <env>             also build that environment's parameters from its .env file
#   validate.sh <env> --azure     also run `az deployment group validate` against Azure
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

environment="${1:-}"
azure="false"
[[ "${2:-}" == "--azure" ]] && azure="true"

node "${EHUB_SCRIPTS_DIR}/validate-bicep.mjs" --require-bicep

if [[ -n "$environment" ]]; then
  load_environment "$environment"
  bicep_cmd=(bicep)
  command -v bicep >/dev/null 2>&1 || bicep_cmd=(az bicep)
  for deploy_apps in false true; do
    EHUB_DEPLOY_APPS="$deploy_apps" EHUB_IMAGE_TAG="validate" \
      "${bicep_cmd[@]}" build-params "$EHUB_PARAMS_FILE" --stdout >/dev/null
  done
  info "Parameters for ${EHUB_ENV} build from ${EHUB_ENV}.env."
  if [[ "$azure" == "true" ]]; then
    require_azure
    az group show --name "$EHUB_RESOURCE_GROUP" --only-show-errors -o none ||
      die "Resource group ${EHUB_RESOURCE_GROUP} does not exist yet; deploy stage 1 first or skip --azure."
    EHUB_DEPLOY_APPS=false EHUB_IMAGE_TAG="" az deployment group validate \
      --resource-group "$EHUB_RESOURCE_GROUP" --parameters "$EHUB_PARAMS_FILE" --only-show-errors -o none
    info "Azure accepted the stage 1 deployment for ${EHUB_ENV}."
  fi
fi
