# Azure infrastructure

`infrastructure/bicep/` deploys one environment (`dev`, `test` or `prod`) into one resource group.
`infrastructure/scripts/` deploys it, shows what would change, rolls back, sets up Teams sign-in
and packages the Teams app. Every script has a bash (`.sh`, Ubuntu and macOS) and a PowerShell 7
(`.ps1`) version with the same steps.

## What is deployed

| Resource                                                      | Purpose                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log Analytics workspace, Application Insights                 | Logs, traces and metrics (docs/observability.md); retention by parameter                                                                                |
| Key Vault (RBAC)                                              | `moodle-token`, `teams-bot-client-secret` (added by you), `appinsights-connection-string` (added by Bicep)                                              |
| Azure AI Search                                               | The E-Hub index. API keys are disabled: everything uses Entra ID. Bicep never creates, changes or deletes the index.                                    |
| Storage account                                               | File share `state` (sync state, identity mappings, admin audit, embedding cache), mounted at `/mnt/state`; blob container `releases` for Teams packages |
| Container registry                                            | The single service image `ehub:<commit>`; no admin user, no anonymous pull                                                                              |
| Three user-assigned managed identities                        | `id-…-api`, `id-…-bot`, `id-…-jobs`: one per workload, each with only its roles                                                                         |
| Container Apps environment                                    | Consumption workload profile; optionally in a virtual network with a NAT gateway                                                                        |
| Container App `ca-…-api`                                      | The answer API and administration page (`node apps/api/dist/cli.js serve`)                                                                              |
| Container App `ca-…-bot`                                      | The Teams bot (`node apps/teams-app/dist/main.js`)                                                                                                      |
| Container Apps jobs `caj-…-sync`, `-enrolments`, `-reconcile` | Scheduled incremental sync (daily), enrolment refresh (every 4 hours), full reconciliation (weekly). Times are in UTC.                                  |
| Azure Bot with the Microsoft Teams channel                    | Routes Teams messages to the bot; the SSO OAuth connection is added by `configure-bot-sso`                                                              |
| Availability tests and alerts                                 | `/health/ready` on the API and `/health/live` on the bot, from three European locations; email when two fail                                            |
| Role assignments on your Azure OpenAI account                 | Cognitive Services OpenAI User for the API and jobs. The account and its model deployments are managed separately.                                      |

Resource names are `<type>-<prefix>-<environment>`, with a 6-character suffix where the name must
be globally unique (Key Vault, Search, Storage, registry, bot), for example `kv-ehub-test-3k2x9a`.

### Environments

|                                  | dev                    | test                              | prod                                |
| -------------------------------- | ---------------------- | --------------------------------- | ----------------------------------- |
| Azure AI Search                  | Free, no semantic      | Basic, 1 replica, semantic (free) | Basic, **2 replicas** (read SLA)    |
| Deletion locks (Search, Storage) | no                     | no                                | **yes**                             |
| Key Vault purge protection       | no (7-day soft delete) | no (7-day soft delete)            | **yes** (90 days, cannot be undone) |
| Storage redundancy               | LRS                    | LRS                               | GRS                                 |
| Log retention                    | 30 days                | 30 days                           | 90 days                             |
| Registry                         | Basic                  | Basic                             | Standard                            |

Every environment runs with `NODE_ENV=production` and real Entra sign-in, so test behaves like
production. Development mock identities are never set in Azure (a repository test checks this).

### Two deployment stages

The services cannot start until their image is in the registry and their secrets are in Key Vault,
and each identity's access is granted per secret, which needs the secret to exist. So:

1. **Foundation** (`--stage foundation`): everything except the services.
2. You add the Moodle token and the bot client secret to Key Vault.
3. **Apps** (`--stage apps`): builds the image in the registry (`az acr build`, so Docker is not
   needed locally), grants per-secret access, and deploys the API, bot, jobs, Azure Bot
   registration and availability tests.

`deploy.sh <env>` runs both, and stops after stage 1 with instructions if a secret is missing.

## Prerequisites

- **Tools**:
  - Azure CLI 2.60 or later, with Bicep (`az bicep install`);
  - Node.js 22.13 or later and pnpm 10 (repository root);
  - git;
  - PowerShell 7.4 or later, only for the `.ps1` scripts.
- **Azure OpenAI** (or Azure AI Foundry) account with:
  - a chat deployment;
  - an embedding deployment whose dimensions match `EHUB_EMBEDDING_DIMENSIONS` (docs/embeddings.md).
    It can be in another resource group of the same subscription. Check model availability for your
    region: South Africa North may not offer the models you want, and the account can be in another
    region.
- **Entra app registrations**:
  - Answer API and bot: docs/entra-sso.md, steps 1–2.
  - Administration page, optional: docs/admin.md.
- **Moodle**: the web-service user and token (docs/moodle-setup.md).
- **Teams**: custom app upload allowed for the pilot users (Teams admin center, setup policy).

### Azure permissions

| Who      | Where                            | Role                                                                   | Why                                                                                       |
| -------- | -------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Deployer | Subscription (once)              | Resource provider registration, e.g. Contributor                       | Register `Microsoft.App`, `Microsoft.BotService`, `Microsoft.Search` and the others below |
| Deployer | The environment's resource group | **Owner**, or Contributor plus Role Based Access Control Administrator | Create resources and their role assignments                                               |
| Deployer | The Azure OpenAI account         | Role Based Access Control Administrator (or Owner)                     | Grant the identities Cognitive Services OpenAI User                                       |
| Deployer | Entra ID                         | Application Administrator, plus someone who can grant admin consent    | App registrations (not done by Bicep)                                                     |

Bicep gives the deployer (`EHUB_DEPLOYER_OBJECT_ID`, filled in from `az login` when empty):

- Key Vault Secrets Officer, to add the secrets;
- Search Service Contributor and Search Index Data Contributor, to create the index from a workstation;
- Storage Blob Data Contributor on `releases`, to upload Teams packages.

Register the providers once per subscription:

```bash
for p in Microsoft.App Microsoft.BotService Microsoft.Search Microsoft.OperationalInsights \
  Microsoft.Insights Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.Storage \
  Microsoft.ManagedIdentity Microsoft.Network Microsoft.AlertsManagement; do
  az provider register --namespace "$p"
done
```

## Identities and roles

| Identity | Role                                                       | Scope                                                              |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| api      | AcrPull                                                    | Registry                                                           |
| api      | Key Vault Secrets User                                     | Secrets `moodle-token`, `appinsights-connection-string`            |
| api      | Cognitive Services OpenAI User                             | Azure OpenAI account                                               |
| api      | Search Index Data Reader + Reader                          | Search service (admin page disabled)                               |
| api      | Search Index Data Contributor + Search Service Contributor | Search service (admin page enabled)                                |
| jobs     | AcrPull                                                    | Registry                                                           |
| jobs     | Key Vault Secrets User                                     | Secrets `moodle-token`, `appinsights-connection-string`            |
| jobs     | Cognitive Services OpenAI User                             | Azure OpenAI account                                               |
| jobs     | Search Index Data Contributor + Search Service Contributor | Search service                                                     |
| bot      | AcrPull                                                    | Registry                                                           |
| bot      | Key Vault Secrets User                                     | Secrets `teams-bot-client-secret`, `appinsights-connection-string` |

Notes:

- **The admin page widens the API's search access.** It runs sync jobs inside the API, so with
  it enabled the API gets the jobs' write roles. Leave `EHUB_ADMIN_SPA_CLIENT_ID` empty to keep
  the API read-only on search; jobs then run only on their schedule or with
  `az containerapp job start`.
- **The API also gets the Reader role on search.** Its health check reads the index definition
  and statistics, which Search Index Data Reader alone cannot. Microsoft's documentation says
  Reader can view object definitions; whether that covers the index statistics call is **not
  verified**. Check it with step 9 below. If search shows `down` with category `authorization`,
  that role is the cause.
- **The bot has no Moodle, Search or model access.** It reads only its own client secret.

### Verifying role assignments

```bash
rg=rg-ehub-test
for id in id-ehub-test-api id-ehub-test-jobs id-ehub-test-bot; do
  principal=$(az identity show -g "$rg" -n "$id" --query principalId -o tsv)
  echo "== $id"
  az role assignment list --assignee "$principal" --all \
    --query "[].{role:roleDefinitionName, scope:scope}" -o table
done
```

Compare the output with the table above. Nothing should be assigned at resource-group or
subscription scope.

## Test environment, step by step

1. **App registrations.** Create them (docs/entra-sso.md steps 1–2; docs/admin.md for the admin
   page). Keep the bot client secret for step 6.
2. **Settings.** `cp infrastructure/environments/test.env.example infrastructure/environments/test.env`
   and fill it in. The file is not committed, and holds no secrets. The scripts refuse to run
   while a placeholder remains, or while an ID or URL is malformed. Set `EHUB_SYNC_COURSE_IDS` to
   one or two pilot courses.
3. **Check.** `infrastructure/scripts/validate.sh test`.
4. **Preview.** `az login`, then `infrastructure/scripts/what-if.sh test`.
5. **Stage 1.** `infrastructure/scripts/deploy.sh test --stage foundation`.
6. **Secrets.** Write each value to a file, add it, then delete the file. This keeps the value
   out of shell history and process lists:

   ```bash
   kv=$(az deployment group show -g rg-ehub-test -n ehub-test-foundation --query properties.outputs.keyVaultName.value -o tsv)
   az keyvault secret set --vault-name "$kv" --name moodle-token --file moodle-token.txt
   az keyvault secret set --vault-name "$kv" --name teams-bot-client-secret --file bot-secret.txt
   shred -u moodle-token.txt bot-secret.txt
   ```

   If `az keyvault` says you are not authorised, your Key Vault Secrets Officer role from stage 1
   has not applied yet. Wait a few minutes.

7. **Stage 2.** Commit first: the image tag is the commit. Then run
   `infrastructure/scripts/deploy.sh test --stage apps`. The script retries once after 90 seconds
   if the new per-secret access has not applied yet. It prints the API URL and the bot's messaging
   endpoint.
8. **Teams sign-in.**
   - Run `infrastructure/scripts/configure-bot-sso.sh test`. It creates the OAuth connection from
     docs/entra-sso.md step 3.
   - Test it in the portal (Azure Bot → Configuration → `ehub-sso` → Test connection).
   - The Entra provider's parameter names are not documented for templates, so the script reads
     them from `az bot authsetting list-providers`. If it cannot find them, it stops and you create
     the connection in the portal instead.
9. **Search index and first checks.** From your workstation, signed in with `az login`:

   ```bash
   export AZURE_SEARCH_ENDPOINT=$(az deployment group show -g rg-ehub-test -n ehub-test-foundation --query properties.outputs.searchEndpoint.value -o tsv)
   export AZURE_SEARCH_VECTOR_DIMENSIONS=1536   # your EHUB_EMBEDDING_DIMENSIONS
   pnpm indexer search:create-index
   pnpm indexer search:validate-index
   ```

   Then run the diagnostic inside the API container. It prints statuses only, never values:

   ```bash
   az containerapp exec -g rg-ehub-test -n ca-ehub-test-api --command "node apps/api/dist/cli.js diagnose"
   ```

10. **First sync.** Start the jobs now rather than waiting for the schedule:

    ```bash
    az containerapp job start -g rg-ehub-test -n caj-ehub-test-sync
    az containerapp job start -g rg-ehub-test -n caj-ehub-test-enrolments
    az containerapp job execution list -g rg-ehub-test -n caj-ehub-test-sync -o table
    ```

    Logs are in Log Analytics (`ContainerAppConsoleLogs_CL`), and traces in Application Insights.

11. **Admin page** (if enabled). Add `https://<API URL>/admin/` as a single-page-application
    redirect URI on the admin registration (docs/admin.md).
12. **Teams package.** Fill in the `EHUB_TEAMS_*` settings, then run
    `infrastructure/scripts/package-teams-app.sh test --upload`. It validates the manifest with
    production rules, prints the package's SHA-256, and stores it under `releases/teams/test/`.
    Upload it in the Teams admin center and assign it to the pilot users.

## Updating an environment

- Code change: commit, then run `deploy.sh <env> --stage apps`. That builds `ehub:<commit>` and
  deploys a new revision of each service.
- Template or parameter change: run `what-if.sh <env> [--stage apps]` first, then `deploy.sh`.
- For production, every script asks you to type the resource group name, or takes `--yes`
  (`-Yes`) for a pipeline.

## Rollback

`rollback.sh <env> [--to-tag <tag>]` points the API, the bot and all three jobs back at an
earlier image, which takes a minute or two. Without `--to-tag` it uses the most recent image in
the API's revision history that differs from the current one.

What it does **not** roll back:

- **Settings and secrets.** If a release changed a setting, redeploy the old commit with
  `deploy.sh <env> --stage apps --image-tag <old tag>`. That puts the old template's settings and
  image back together.
- **State on the file share.** The state files carry a format version, but whether an older
  image can read state that a newer one wrote has not been checked release by release. Check
  the release notes before rolling back across a state change.
- **The search index.** Rolling back the image does not change the index. If the index schema
  changed, see docs/search-index.md.

After a rollback, deploy with `--image-tag <rolled-back tag>` until the fix is released.
Otherwise the next `deploy.sh` builds and deploys the current commit again.

Container Apps keeps the last 10 inactive revisions. The registry keeps every tag unless you
delete it, so do not purge recent tags.

## Moodle reachability

The services call Moodle from Azure.

- **Moodle reachable from the internet:** nothing to do.
- **Moodle firewall allows listed addresses only:** set `EHUB_ENABLE_VNET=true`. The environment
  then goes in a virtual network with a NAT gateway, and every outbound call leaves from one static
  IP (`outboundIp` in the deployment outputs). Add that address to the Moodle firewall. Switching
  an existing environment into a virtual network replaces the Container Apps environment: plan it
  before the pilot, not during it.
- **Moodle only on the internal network or VPN:** this template does not connect to it. Options
  are a site-to-site VPN or ExpressRoute into the virtual network, or publishing the web-service
  endpoint through a reverse proxy with an IP allowlist. Decide which before deploying.

## Limits of the file-based state

The sync state, identity mappings and admin records are JSON files on the Azure Files share,
written by the code from phases 11–15. Those stores were built for one machine:

- each read-modify-write takes a lock file created exclusively;
- files are replaced by rename;
- a lock older than 60 seconds is broken.

Consequences:

- **One API replica** (`maxReplicas: 1`). The API also keeps its authorisation cache and rate
  limits in memory. The bot has one replica too: Teams needs a warm instance.
- **Locking over SMB is not verified.** Exclusive create and rename over SMB are the operations
  the file stores rely on. They are expected to work, but have not been tested against Azure
  Files. A job and the API writing at the same moment is the case to watch in the pilot.
- **A brief overlap during revision changes.** For a few seconds the old and new revisions both
  run against the same share. The locks cover that, subject to the point above.
- **Shared-key access stays on.** Container Apps can mount Azure Files only with the storage
  account key (Microsoft confirmed this up to API version 2026-01-01). The account therefore
  cannot have shared-key access turned off.

This is acceptable for the pilot. **Before production with all staff**, replace the stores with a
database implementation: Azure SQL or PostgreSQL, layout in docs/sync.md, "Production
implementations". Each implementation must pass the existing repository contract tests. Then the
API can scale out.

## Disaster recovery assumptions

| What                | How it is recovered                                                                                                                                                    | Assumption                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Infrastructure      | Re-run the scripts: the templates are complete                                                                                                                         | One region; no standby region                                                                 |
| Search index        | Rebuilt from Moodle: `search:create-index`, then `sync:full`. Allow hours for a large course set; answers are unavailable meanwhile                                    | Moodle is the source of truth                                                                 |
| Sync state          | Lost state is rebuilt by a full sync. Deleted shares are recoverable for the soft-delete period (7 days test, 30 prod)                                                 | No Azure Files backup is configured (see below)                                               |
| Identity mappings   | Manual overrides exist only on the state share. Copy the `identity` folder off regularly (portal → storage account → File shares → `state`, or Azure Storage Explorer) | Email matching re-creates the automatic mappings                                              |
| Admin audit records | In the state share, retained per `ADMIN_RETENTION_DAYS`                                                                                                                | Not copied elsewhere                                                                          |
| Secrets             | Key Vault soft delete (7 days test, 90 prod; purge protection in prod)                                                                                                 | The Moodle token and bot secret can also be reissued                                          |
| Images              | Kept in the registry by tag; any commit can be rebuilt                                                                                                                 | Rebuilding later uses the base image of that day unless `EHUB_NODE_IMAGE` is pinned by digest |
| Region outage       | Redeploy into another region with a new resource group, then rebuild the index                                                                                         | Hours of downtime are acceptable for this service                                             |

Not included, and worth adding for production:

- **Azure Backup for the state share** (a Recovery Services vault). It needs a policy decision on
  retention and cost.
- **Alert rules from docs/observability.md.** Only the availability alerts are deployed. The
  other eight log alerts are documented but not deployed, because their queries have not been
  checked against real data yet (Phase 20).

## Checks in the repository

- `pnpm infra:validate` (`infrastructure/scripts/validate-bicep.mjs`):
  - lints every template and fails on any warning;
  - builds `main.bicep`;
  - builds all three parameter files for both stages, using placeholder values.
    It is reported as skipped when no Bicep CLI is installed. `validate.sh` and `validate.ps1`
    require it.
- `tests/integration/infrastructure.test.ts`:
  - runs that validation when Bicep is installed;
  - checks that the settings `main.bicep` gives each service pass that service's production
    configuration;
  - checks the template's protections: no committed IDs or keys, no secret outputs, HTTPS only,
    Search keys off, production locks.
- `tests/integration/infrastructure-scripts.test.ts` runs the real bash and PowerShell scripts
  against a fake `az`. It checks:
  - order of operations, the missing-secret stop, the retry and production confirmation;
  - rollback target choice and SSO setup;
  - that settings-file contents are never executed.
    The PowerShell cases run when `pwsh` is installed.
- `tests/integration/azure-monitor-instrumentation.test.ts` (Phase 16) runs the real Azure Monitor
  distribution.
