# Independent pilot and MCP client evaluation

Owner-selected clients: Codex desktop and ChatGPT Work web (2026-10-20). No completed client/model runs are claimed by this document.
The existing synthetic NavoCMS/Sites pilot is the proposed bundle; confirm its
scope before starting the seven-day owner pilot. Do not import a real site.

## Connect without author credentials

In Codex, configure a remote MCP server using its exact HTTPS `/mcp` URL in the
MCP developer settings or the supported `codex mcp add` workflow. Authenticate
through WorkOS using the owner's account, never a copied bearer token. In ChatGPT,
use Plugins → Add custom MCP server, enter the same HTTPS endpoint, configure
OAuth, install the resulting private plugin and select it in a new chat. Register
the exact redirect URI/client metadata shown by the host in WorkOS; callbacks
are not interchangeable between hosts. Account/workspace availability is a
prerequisite to test, not a promised capability inferred from successful Codex use.

Current official guidance: [developer settings](https://learn.chatgpt.com/docs/developer-settings),
[MCP plugin quickstart](https://developers.openai.com/plugins/build/app-quickstart)
and [OAuth contract](https://developers.openai.com/plugins/build/auth).

Start by asking the agent to identify the connected site and its permissions
from the passport. Authorize a second site independently through a separately
named connection and endpoint. Explicitly name the target site in each request;
check its passport IDs before changing anything. The current runtime is pinned
to one site per endpoint. There is no single multi-site gateway or automatic
site selection. Missing membership must deny access even when the caller guesses
another site's revision/change/comment ID. Record the real two-site rehearsal;
unit RLS tests alone do not complete that receiving-owner gate.

## Two clean runs per client

Use a fresh chat/session and fresh synthetic starting state for each run. The
model receives user goals, not a prescribed tool sequence. Do not replay this
implementation chat or a shell script of known tool calls. Each client performs
all ten tasks twice. Keep failed, blocked, retried and slow attempts.

| Task | User goal and expected result |
| --- | --- |
| text | Change a paragraph; reach a real preview without losing other fields. |
| photo | Upload the supplied synthetic image, bind it, preview responsive variants. |
| page | Create a page in an existing registered type and locale. |
| metadata | Change an allowed field while preserving slug/locale/body. |
| relation | Create or select a related record and retain a valid reference. |
| design | Make one block compact using the approved policy and preview it. |
| conflict | Compete with a direct browser edit; preserve both inputs and resolve explicitly. |
| comment | Save and read an element/field comment with stable anchors. |
| resume | Disconnect, start a fresh conversation, recover the durable change and continue. |
| rollback | Identify and restore an owner-approved previous release through normal policy. |

Publication/rollback is never silently authorized by these test prompts. The
owner handles genuine publication decisions. Record human interventions and
blocked attempts; do not forge receipts to improve completion rate. A planned
human decision is distinguishable from author shell/SQL assistance.

Record per task: client/version/model, run and session ID, source SHA/site,
start/end timestamps including retries, outcome, model tool-call count, tokens
and cost when exposed (otherwise null), human interventions and author shell/SQL.
Keep the original redacted client transcript and its SHA-256. The evidence file
contains hashes/counts, not access tokens, personal content or hidden reasoning.
The independent reviewer checks the originals; the validator cannot prove that
a declared transcript actually came from a model by inspecting a hash alone.

## Gate calculation

`pilot-evaluation.v1` has clientNames (two distinct names), runs, usageDays,
sourceCommit, pilotSiteId, safety incident counts and independent ownerReview.
A run names client/runId/model, real-model-mcp execution, cleanSession=true and
ten task records. Task names are text/photo/page/metadata/relation/design/conflict/
comment/resume/rollback. Each task records startedAt, finishedAt, outcome,
authorShellOrSql, humanInterventions, toolCalls, transcriptSha256 and nullable
inputTokens/outputTokens/costUsd. The runtime Zod schema is authoritative.

```sh
node apps/mcp/dist/operations-cli.js evaluate /private/pilot/evidence.json
```

The command exits nonzero for missing coverage, duplicate transcripts, fewer
than two clean runs per client, completion below 90% without author shell/SQL,
median text-to-preview above three minutes, safety incidents, fewer than seven
human usage days or pending independent review. It never authorizes publication.
A successful synthetic validator unit fixture is not real pilot evidence.

The owner records at least seven days of actual editorial use, all blocking
issues and the incident/backup alert route. Measure RPO and RTO in a real
independent recovery rehearsal with the retained archive and keys. Production
cutover remains a separate URL/SEO/locale/consent/forms review and owner decision.
