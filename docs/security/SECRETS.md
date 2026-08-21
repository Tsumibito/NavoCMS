# Secret management policy

**Status:** Accepted foundation policy

**Applies to:** NavoCMS core, contributors, self-hosted deployments, hosted NavoCMS, plugins, CI,
and release artifacts

## Decision

NavoCMS separates portable open-source code from operator-owned deployment state.

| Boundary | May contain | Must not contain |
|---|---|---|
| Public NavoCMS repository | `.env.example`, variable names, schemas, secret references, fake test values | Plaintext secrets, production ciphertext, `.env.keys`, private/decryption keys |
| Private deployment repository | dotenvx-encrypted `.env.<environment>`, deployment manifests, pinned NavoCMS version | `.env.keys`, plaintext secrets, tenant/plugin secret values |
| Deployment platform secret store | The minimum `DOTENV_PRIVATE_KEY_<ENVIRONMENT>` and platform-native bootstrap keys | General application configuration, tenant content, exported key files |
| Runtime secret provider | Tenant/site/plugin credentials encrypted at rest and scoped by policy | Values in ordinary NavoCMS tables, events, logs, MCP results, or exports |
| PostgreSQL | Opaque secret reference, provider, label, scope, allowed plugin IDs, audit metadata | Secret plaintext or decryptable ciphertext |

The public repository therefore takes a stricter position than the dotenvx cryptographic minimum:
although dotenvx supports committing an encrypted `.env` file, production ciphertext belongs to a
specific operator and deployment. Keeping it in a private deployment repository avoids permanent
public ciphertext, environment coupling, noisy forks, and a larger incident scope if a decryption
key is ever exposed.

A recommended private overlay looks like this:

```text
navocms-deployment/          private repository
├── .env.example             names only
├── .env.staging             dotenvx ciphertext
├── .env.production          dotenvx ciphertext
├── .env.keys                local only; ignored and never committed
├── compose.yaml             or equivalent deployment manifests
└── navocms.version          pinned core image/revision
```

This overlay is operator infrastructure, not part of the portable NavoCMS core. Different
self-hosters can use dotenvx, workload identity, or another compatible bootstrap mechanism without
forking NavoCMS.

## What dotenvx protects

Use dotenvx for deployment bootstrap configuration. It generates a public encryption key inside the
encrypted `.env` file and a corresponding private decryption key in `.env.keys`. The encrypted file
may be versioned in the private deployment repository. `.env.keys` must be ignored everywhere.

Use a distinct key pair for each environment. Production, staging, CI, and local development must
not share a decryption key. At runtime, inject only the matching
`DOTENV_PRIVATE_KEY_<ENVIRONMENT>` through the deployment platform and execute the process through
`dotenvx run`. Do not decrypt to a persistent file, image layer, build log, or shell transcript.

The official dotenvx documentation describes encrypted files, environment-specific private-key
variables, `.env.keys` exclusion, validation, and pre-commit protection:
[dotenvx repository and CLI reference](https://github.com/dotenvx/dotenvx) and
[production operations](https://dotenvx.com/docs/ops/production).

## Bootstrap secrets versus managed site secrets

Deployment bootstrap secrets are the small set needed before NavoCMS can start, such as:

- PostgreSQL application credential;
- OIDC/OAuth client or signing credential when required by the selected identity provider;
- credential for the configured runtime secret provider;
- object-storage or deployment-provider bootstrap credential when it cannot use workload identity.

Provider API keys supplied by tenants, site administrators, or plugins are not bootstrap variables.
For example, an OpenRouter key for one site is written through the NavoCMS Secret Broker to the
runtime secret provider. NavoCMS persists only its site-scoped reference and releases the value only
to an authorized plugin for a bounded operation.

Prefer workload identity and short-lived credentials over stored long-lived credentials whenever a
provider supports them.

## Repository and CI rules

- Only `.env.example` may be tracked in the public repository. It contains safe defaults or empty
  values, never encrypted production values.
- `.env`, deployment-specific `.env.*`, `.env.keys`, and `.env.keys.*` are ignored in the public
  repository; `.env.example` is the sole exception.
- Public pull-request CI uses generated databases and fake credentials. It never receives production
  decryption keys or production secrets, including for pull requests from maintainers.
- Deployment CI runs from the private deployment context. Its logs must mask private keys and must
  not print the decrypted environment.
- A private deployment repository should run `dotenvx validate --strict` and `dotenvx precommit`
  before deployment. The public core additionally rejects tracked environment/key files through
  `pnpm check:secrets`.
- Container builds may contain code and, if the operator chooses, encrypted deployment data. The
  private key is injected only at runtime and never copied into the image.

## Rotation and incident handling

Rotate the environment key pair when a maintainer or deployment loses access, a key reaches an
untrusted machine, CI/platform access changes materially, or exposure is suspected. Re-encrypt the
private deployment environment, update the platform key, deploy, verify, and retire the old key.

If a decryption key is exposed, assume every ciphertext ever available to that key can be decrypted.
Rotate both the dotenvx key pair and every underlying credential from the affected environment.
Deleting or rewriting Git history is not a substitute for credential rotation.

Secret access is an auditable event about a reference, actor, plugin, purpose, and lease. Audit data
must never include the value, decrypted bytes, authorization header, or provider response containing
credentials.

## Local development

Copy `.env.example` to an ignored `.env.local` only when local overrides are needed. Store the
private key outside Git, using a local ignored `.env.keys` or the operating system credential store.
Never paste a real secret into an issue, PR, agent conversation, test fixture, terminal transcript,
or support bundle.
