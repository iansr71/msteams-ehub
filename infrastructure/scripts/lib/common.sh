#!/usr/bin/env bash
# Shared helpers for the deployment scripts. Sourced, not run.
#
# Settings come from infrastructure/environments/<env>.env (KEY=value lines, not committed).
# The file is parsed line by line, never sourced or evaluated, so a value cannot run code.

# shellcheck disable=SC2034  # variables here are used by the scripts that source this file

EHUB_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EHUB_REPO_ROOT="$(cd "${EHUB_SCRIPTS_DIR}/../.." && pwd)"
EHUB_BICEP_DIR="${EHUB_REPO_ROOT}/infrastructure/bicep"

info() { printf '%s\n' "$*" >&2; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

GUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
NIL_GUID='00000000-0000-0000-0000-000000000000'

require_guid() {
  local name="$1" value="${!1:-}"
  [[ "$value" =~ $GUID_PATTERN ]] || die "${name} must be a GUID."
  [[ "$value" != "$NIL_GUID" ]] || die "${name} is still the placeholder value."
}

require_https_url() {
  local name="$1" value="${!1:-}"
  [[ "$value" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^?#[:space:]]*)?$ ]] ||
    die "${name} must be an https URL without a query string."
  [[ "$value" != *example.com* && "$value" != *example.test* ]] || die "${name} is still the placeholder value."
}

require_value() {
  local name="$1"
  [[ -n "${!1:-}" ]] || die "${name} is required in the environment file."
}

# load_environment <dev|test|prod>: exports EHUB_* settings from the environment file.
load_environment() {
  EHUB_ENV="${1:-}"
  [[ "$EHUB_ENV" =~ ^(dev|test|prod)$ ]] || die "Environment must be dev, test or prod."
  local file="${EHUB_ENV_FILE:-${EHUB_REPO_ROOT}/infrastructure/environments/${EHUB_ENV}.env}"
  [[ -f "$file" ]] || die "Missing ${file}. Copy ${EHUB_ENV}.env.example and fill it in."

  local line key value number=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    number=$((number + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^(EHUB_[A-Z0-9_]+)=(.*)$ ]] || die "${file}:${number}: expected EHUB_NAME=value."
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    # Optional surrounding quotes; no expansion of any kind.
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    export "${key}=${value}"
  done <"$file"

  export EHUB_NAME_PREFIX="${EHUB_NAME_PREFIX:-ehub}"
  [[ "$EHUB_NAME_PREFIX" =~ ^[a-z][a-z0-9]{1,7}$ ]] || die "EHUB_NAME_PREFIX: 2-8 lower-case letters or digits, starting with a letter."
  require_guid EHUB_SUBSCRIPTION_ID
  require_value EHUB_RESOURCE_GROUP
  require_value EHUB_LOCATION
  require_guid EHUB_ENTRA_API_CLIENT_ID
  require_guid EHUB_BOT_CLIENT_ID
  [[ -z "${EHUB_ADMIN_SPA_CLIENT_ID:-}" ]] || require_guid EHUB_ADMIN_SPA_CLIENT_ID
  [[ -z "${EHUB_DEPLOYER_OBJECT_ID:-}" ]] || require_guid EHUB_DEPLOYER_OBJECT_ID
  require_https_url EHUB_MOODLE_BASE_URL
  require_https_url EHUB_OPENAI_ENDPOINT
  require_value EHUB_OPENAI_ACCOUNT_NAME
  require_value EHUB_OPENAI_RESOURCE_GROUP
  require_value EHUB_OPENAI_CHAT_DEPLOYMENT
  require_value EHUB_OPENAI_EMBEDDING_DEPLOYMENT
  [[ "${EHUB_EMBEDDING_DIMENSIONS:-}" =~ ^[0-9]+$ ]] || die "EHUB_EMBEDDING_DIMENSIONS must be a whole number."
  [[ -n "${EHUB_SYNC_COURSE_IDS:-}" ]] || warn "EHUB_SYNC_COURSE_IDS is empty: the sync jobs will index nothing until it is set."
  [[ -z "${EHUB_SYNC_COURSE_IDS:-}" || "$EHUB_SYNC_COURSE_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]] ||
    die "EHUB_SYNC_COURSE_IDS must be comma-separated course IDs, e.g. 12,15."
  export EHUB_SSO_CONNECTION_NAME="${EHUB_SSO_CONNECTION_NAME:-ehub-sso}"
  export EHUB_PARAMS_FILE="${EHUB_BICEP_DIR}/parameters/${EHUB_ENV}.bicepparam"
  export EHUB_FOUNDATION_DEPLOYMENT="ehub-${EHUB_ENV}-foundation"
  export EHUB_APPS_DEPLOYMENT="ehub-${EHUB_ENV}-apps"
}

# require_azure: az is installed, signed in, and pointed at the environment's subscription.
require_azure() {
  command -v az >/dev/null 2>&1 || die "The Azure CLI (az) is not installed: https://aka.ms/installazurecli"
  az account show --only-show-errors >/dev/null 2>&1 || die "Not signed in. Run: az login"
  az account set --subscription "$EHUB_SUBSCRIPTION_ID" --only-show-errors ||
    die "Cannot select subscription ${EHUB_SUBSCRIPTION_ID}."
  if [[ -z "${EHUB_DEPLOYER_OBJECT_ID:-}" ]]; then
    EHUB_DEPLOYER_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv --only-show-errors 2>/dev/null || true)"
    export EHUB_DEPLOYER_OBJECT_ID
    [[ -n "$EHUB_DEPLOYER_OBJECT_ID" ]] ||
      warn "Could not read your object ID; set EHUB_DEPLOYER_OBJECT_ID (and EHUB_DEPLOYER_PRINCIPAL_TYPE for a pipeline)."
  fi
}

# deployment_output <deployment name> <output name>
deployment_output() {
  az deployment group show --resource-group "$EHUB_RESOURCE_GROUP" --name "$1" \
    --query "properties.outputs.${2}.value" -o tsv --only-show-errors
}

# confirm_production: asks before changing prod unless --yes was given.
confirm_production() {
  local assume_yes="$1" action="$2"
  [[ "$EHUB_ENV" == "prod" && "$assume_yes" != "true" ]] || return 0
  [[ -t 0 ]] || die "Refusing to ${action} production without --yes (no terminal to confirm)."
  local answer
  read -r -p "About to ${action} PRODUCTION (${EHUB_RESOURCE_GROUP}). Type the resource group name to continue: " answer
  [[ "$answer" == "$EHUB_RESOURCE_GROUP" ]] || die "Not confirmed."
}

# image_tag: the commit being deployed; refuses uncommitted changes unless allowed.
image_tag() {
  local allow_dirty="$1"
  git -C "$EHUB_REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "Not a git checkout: pass --image-tag."
  if [[ "$allow_dirty" != "true" && -n "$(git -C "$EHUB_REPO_ROOT" status --porcelain)" ]]; then
    die "Uncommitted changes: commit first (the image tag must identify the code), or pass --allow-dirty."
  fi
  git -C "$EHUB_REPO_ROOT" rev-parse --short=12 HEAD
}
