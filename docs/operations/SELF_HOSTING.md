# Pilot self-hosting and recovery

Profile: `docker-workos-neon-cloudflare-pilot-v1`. The supported target is a
single dedicated site database on PostgreSQL 18, with Docker/HTTPS, WorkOS,
Cloudflare Pages and R2. Coolify can manage Docker and HTTPS. Another verified
PostgreSQL 18 host can replace Neon; another HTTPS proxy can replace Coolify.
Other identity/storage/delivery implementations have not been accepted.
Sites is an optional separately hosted consumer. This is staging pilot support,
not production cutover or an offline installation claim.

## Owner prerequisites

The site owner supplies accounts, private billing decisions, a dedicated empty
PostgreSQL database, R2 bucket, Pages project, WorkOS organization/users/roles and
a stable HTTPS CMS hostname. Select the owner and incident contact before use.
Register the exact OAuth resource `<cms-origin>/mcp`, client callback URLs shown
by each MCP client, and browser callback `<cms-origin>/confirmations/callback`.
Account sign-in and consent belong to the owner. Never paste secrets into chat.

Use the same database owner role name on recovery targets. Provider credentials,
database passwords and dotenvx keys stay outside the recovery archive. Preserve
these in the owner's approved key recovery process. Reconcile revoked identities,
browser sessions and external delivery state before activating restored data.

## Prepare a reviewed release

Check out a specific reviewed main commit, record that SHA and use its lockfile.
Do not deploy a floating branch. The examples are complete public templates;
there are no required author-private files.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Copy `examples/operations/site-bootstrap.json` and `bindings.json` into an ignored
operator directory. Replace example tenant/site/environment/principal IDs, the
human WorkOS issuer/subject, hostname, Cloudflare account/project and R2 endpoint/
bucket. Preserve one identical site identity across the files. The service
principal is the runtime principal, separate from the human owner.

Generate reviewed binding pins without credentials:

```sh
node apps/mcp/dist/operations-cli.js pins /private/operator/bindings.json
```

The output names NAVOCMS_STAGING_BINDING, NAVOCMS_STAGING_BINDING_DIGEST,
NAVOCMS_STAGING_HOSTNAME, NAVOCMS_R2_RUNTIME_BINDING and its digest. Use them in
the runtime configuration; operations needs the R2 pair too.

## Encrypted configuration

`deploy/self-host/runtime.env.example` lists every runtime setting.
`operations.env.example` lists separate privileged settings. Fill OIDC organization
and role permissions using the owner-configured WorkOS roles; role claims are
intersected with database site membership. Runtime mode is production and delivery
environment is staging. The browser login client uses its own ID/secret and the
provider's authorization, token and logout endpoints. Session lifetime remains
the existing 360-day maximum with expiry, revocation and refresh checks.

Use installed pinned dotenvx 2.15.1 and the hidden local entry helper. It writes
only encrypted values, uses mode 0600 and stores the decryption key in the local
`<env-file>.keys` file. The value never enters shell history or process arguments.
The generated backup key is independent of database/OAuth credentials.

```sh
node deploy/self-host/set-secret.mjs "$(npm root -g)/@dotenvx/dotenvx" /private/operator/.env.runtime NAVOCMS_DATABASE_URL
node deploy/self-host/set-secret.mjs "$(npm root -g)/@dotenvx/dotenvx" /private/operator/.env.operations NAVOCMS_MIGRATION_DATABASE_URL
node deploy/self-host/set-secret.mjs "$(npm root -g)/@dotenvx/dotenvx" /private/operator/.env.operations NAVOCMS_BACKUP_KEY --generate
```

Repeat for the required names in both templates. Public values can use the same
helper. The runtime database identity must be navocms_runtime with NOBYPASSRLS;
use the direct owner endpoint only in operations, and a pooled runtime endpoint
in the CMS. Use verified TLS. Keep R2 secret values under names derived from the
reviewed secret references; the examples use DOTENVX_SECRET_R2_ACCESS_KEY,
DOTENVX_SECRET_R2_SECRET_KEY and DOTENVX_SECRET_DELIVERY_CLOUDFLARE_TOKEN.

Only the correct decryption key enters each container's platform secret field as
DOTENV_PRIVATE_KEY. The operations key is separate. Do not mount .keys files in
CMS, source control or the backup directory. Do not rotate an existing shared
cluster's navocms_runtime password accidentally: the supported profile dedicates
that role/project to this installation. Reusing a cluster requires its existing
role credential and a reviewed migration plan.

## Install, diagnose, activate

Set Compose coordinates from `deploy/self-host/.env.example` in the protected
operator environment. Paths identify the encrypted runtime/operations files,
bootstrap JSON and backup directory. Give the container user read access to its
encrypted file. The operations container uses the postgres OS user; its backup
mount must be private and writable by that user. The runtime uses UID 1001.
HTTPS ingress forwards to loopback port 8788.

```sh
docker compose -f deploy/self-host/compose.yml --profile operations build
# Stops before activation on any migration or diagnostic failure.
deploy/self-host/activate.sh
```

Install runs ordered registered migrations, runtime-role provisioning, repeatable
site/identity bootstrap and conditional R2 namespace initialization. Existing
foreign namespace markers are rejected, never overwritten. A migration error
stops the command before activation. Repeat install with unchanged credentials
is safe. The activation script stops an unhealthy new container and leaves a
failed migration unactivated. Set NAVOCMS_HEALTH_ORIGIN only after HTTPS is available; doctor then
checks /healthz and /readyz in addition to runtime RLS, exact migration registry,
site identity and object storage markers. Logs contain codes, not credentials.

Connect an owner-authorized MCP client, read the passport, create synthetic
content and request the first preview. The first preview does not publish.
The browser editor and confirmation page reuse the human session. Publishing
requires the independent exact-hash human decision.

## Upgrade and rollback

1. Produce a verified encrypted backup, record its snapshot time and keep the
   old exact image SHA. Review migration compatibility and available space.
2. Stop mutation/GC jobs during a consequential upgrade. Run the new operations
   image's install against the same encrypted configuration. Do not edit SQL.
3. Run doctor before switching the runtime image, then check authenticated MCP,
   preview, media, locale routes and published snapshot after activation.
4. On migration failure keep the old runtime stopped or read-only as appropriate.
   Never activate an incompatible binary. A binary rollback does not undo data
   migrations. Restore into a new empty database when backward compatibility is
   unproven; verify and explicitly switch provider/configuration afterwards.

## Backup and restore

Keep GC retention longer than a successful backup interval. Each backup uses an
exported PostgreSQL snapshot and content-addressed objects. Missing/changed bytes
fail the whole operation. No plaintext dump or personal data is logged.

```sh
docker compose -f deploy/self-host/compose.yml --profile operations run --rm operations node dist/operations-cli.js backup /backups/first.navo
# Configure NAVOCMS_RESTORE_DATABASE_URL to a separate EMPTY direct endpoint.
docker compose -f deploy/self-host/compose.yml --profile operations run --rm operations node dist/operations-cli.js restore /backups/first.navo
```

Restore verifies the encryption tag, site scope, registry and PostgreSQL major;
refuses any existing navocms schema; restores immutable objects, schema, rows and
ACLs; compares table/object inventories; and returns restored-not-activated.
Retry a failed restore in another empty target after inspecting its error code.
Do not point the CMS at a partial target. Restore uses the configured R2 target;
for an independent provider recovery use a separate bucket containing the same
reviewed namespace markers, initialized through the owner installation procedure.
The backup contains exact object bytes, not just links to the old bucket.

Provision the restored cluster's runtime login with the existing documented
`packages/persistence-postgres/dist/provision-runtime-role.js` command and its
encrypted NAVOCMS_MIGRATION_DATABASE_URL/NAVOCMS_RUNTIME_DATABASE_PASSWORD. This
is separate credential recovery, not a password from the archive. Update the
runtime database URL and reviewed R2 binding/digest, run doctor, reconcile
external WorkOS revocations and Pages/Sites publication pointers, and explicitly
activate only after owner review. Restoring never creates a publication receipt.

The pilot format bounds serialized content to 128 MiB, object bytes to 64 MiB
in aggregate and individual objects to 32 MiB. Check size before adopting a
larger site. Deleted trash, in-flight uploads, environment secrets and unrelated
schemas/sites are excluded. Recovery format v1 requires the same runtime registry
and owner role name; historical or future-version restore must use its matching
reviewed release first, followed by a separately tested upgrade.

## Schedule, alert and recovery objectives

Install the provided systemd units only after the first manual backup/restore
succeeds. The examples assume /opt/navocms and /var/backups/navocms. The latest archive
link uses NAVOCMS_BACKUP_DIRECTORY, matching the Compose mount. Keep all
backup generations; the owner defines off-host encrypted copies and retention.
An archive on the CMS host alone does not protect against host loss.

```sh
systemctl enable --now navocms-backup.timer navocms-monitor.timer
```

Copy the supplied units to the host's systemd unit directory first, reload the
manager, and provide the protected /etc/navocms/compose-coordinates file. The
runtime stays running independently of timers. Backup rotates the latest symlink
only after success. Monitor checks HTTPS readiness and authenticated archive
creation time, not a touchable filesystem timestamp. Failures exit nonzero and
emit operations events; OnFailure records an error in the local journal.
The owner must route and test an actual external alert channel separately.

RPO target: at most 24 hours. Scheduled backups run twice daily; an archive older
than 24 hours triggers an alert. RTO must be measured in the independent rehearsal
and repeated after material changes; no production RTO is promised from fixture
timing. Record snapshot time, restored table/object hashes, elapsed time, human
interventions, off-host availability and the reviewed source SHA in the submission.
Seven days of owner use and real model/client evaluations remain separate gates.

## Companion for an existing Coolify runtime

Use `deploy/self-host/operations.compose.yml` when the CMS is already managed by
Coolify. Set NAVOCMS_COMPOSE_FILE to that path in the protected systemd coordinate
file. This file contains only the operations service, so backup/monitor cannot
start a second CMS or require its runtime decryption key. Pin the deployed source
SHA, the encrypted operations environment and backup directory.
Only DOTENV_OPS_PRIVATE_KEY enters the operations container. Build the operations
image at that source, run doctor, backup and monitor manually before enabling the
timers. The existing runtime is not restarted by this companion profile.
