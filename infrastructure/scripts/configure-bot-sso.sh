#!/usr/bin/env bash
# Creates (or replaces) the Azure Bot OAuth connection used for Teams single sign-on
# (docs/entra-sso.md, step 3), from the values already in the environment file and Key Vault.
# Usage: configure-bot-sso.sh <dev|test|prod> [--yes]
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ $# -ge 1 ]] || die "Usage: configure-bot-sso.sh <dev|test|prod> [--yes]"
environment="$1"
assume_yes="false"
[[ "${2:-}" == "--yes" ]] && assume_yes="true"

load_environment "$environment"
require_azure
confirm_production "$assume_yes" "change sign-in for"

bot_service="$(deployment_output "$EHUB_APPS_DEPLOYMENT" botServiceName)"
vault="$(deployment_output "$EHUB_FOUNDATION_DEPLOYMENT" keyVaultName)"
[[ -n "$bot_service" && -n "$vault" ]] || die "Deploy both stages first."
tenant_id="$(az account show --query tenantId -o tsv --only-show-errors)"
[[ "$tenant_id" =~ $GUID_PATTERN ]] || die "Could not read the tenant ID of the signed-in account."

# The Entra ID provider's parameter keys are not documented for templates; ask the service.
keys="$(az bot authsetting list-providers --provider-name Aadv2 -o json --only-show-errors |
  node "${EHUB_SCRIPTS_DIR}/lib/find-provider-params.mjs")" ||
  die "Create the connection in the portal instead (docs/entra-sso.md, step 3)."
tenant_key="$(sed -n 1p <<<"$keys")"
exchange_key="$(sed -n 2p <<<"$keys")"

secret="$(az keyvault secret show --vault-name "$vault" --name teams-bot-client-secret \
  --query value -o tsv --only-show-errors)"
[[ -n "$secret" ]] || die "teams-bot-client-secret is empty in ${vault}."

if az bot authsetting show --resource-group "$EHUB_RESOURCE_GROUP" --name "$bot_service" \
  --setting-name "$EHUB_SSO_CONNECTION_NAME" --only-show-errors -o none 2>/dev/null; then
  az bot authsetting delete --resource-group "$EHUB_RESOURCE_GROUP" --name "$bot_service" \
    --setting-name "$EHUB_SSO_CONNECTION_NAME" --only-show-errors -o none
fi
# The Azure CLI takes the secret only as an argument, so it is briefly visible to other
# processes of this user on this machine. Run this from a trusted workstation.
az bot authsetting create --resource-group "$EHUB_RESOURCE_GROUP" --name "$bot_service" \
  --setting-name "$EHUB_SSO_CONNECTION_NAME" --service Aadv2 \
  --client-id "$EHUB_BOT_CLIENT_ID" --client-secret "$secret" \
  --provider-scope-string "api://${EHUB_ENTRA_API_CLIENT_ID}/access_as_user" \
  --parameters "${tenant_key}=${tenant_id}" "${exchange_key}=api://botid-${EHUB_BOT_CLIENT_ID}" \
  --only-show-errors -o none
unset secret

info "OAuth connection ${EHUB_SSO_CONNECTION_NAME} created on ${bot_service}."
info "Test it in the portal: Azure Bot → Configuration → ${EHUB_SSO_CONNECTION_NAME} → Test connection."
