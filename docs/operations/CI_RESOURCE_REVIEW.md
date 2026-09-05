# CI resource review — 2026-09-05

## Finding

`Tsumibito/NavoCMS` is currently **public** (verified through the repository API) and runs
one `check` job on the standard `ubuntu-latest` runner. These runs do not consume the owner's
included private-repository Actions minutes under the current
[GitHub billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
The owner's reported exhausted 3,000-minute allowance cannot be attributed to this workflow
under its current visibility/runner configuration. Historical visibility changes and other
repositories have not been audited. The account billing API was unavailable to the current
credential (HTTP 404; additional user scope required), so no account-wide usage attribution
or claimed monthly saving is presented.

## Measured baseline

The latest successful PR #53 run at the time of review:
[33989248153](https://github.com/Tsumibito/NavoCMS/actions/runs/33989248153),
head `58d105af3c6f7e94fbd1855b91671423d3f1f86c`.
Job timestamps span **122 seconds**; individual step boundaries are rounded to seconds.

| Step | Seconds |
| --- | ---: |
| PostgreSQL container initialization | 11 |
| Locked dependency installation | 4 |
| Chromium and OS dependencies | 23 |
| Database provision, including three build invocations | 8 |
| Full check: contracts, types, docs, catalogue, tests and browser checks | 40 |
| Five SQL isolation suites | 1 |
| Production Docker build | 28 |

The last 100 run records span 2026-08-24 to 2026-09-05: 65 pull-request, 23 push and 12
GitHub dynamic runs; 70 success, 25 failure and 5 cancelled. This is a bounded sample,
not a monthly invoice, and dynamic runs must not be equated with the quality workflow.

## Applied simplification

- Draft PRs do not allocate the `check` runner. Moving a PR to ready for review triggers
  the full check. Later pushes to ready PRs still trigger it, preserving current-head evidence.
- `main` keeps its full gate. Manual dispatch remains available for an explicit full run.
- Database provisioning builds once and calls the three existing built entry points.
  It no longer rebuilds the entire workspace before each of the three provisioning commands.
  The independent `pnpm check` gate and container build remain intact.
- The runaway timeout is 8 minutes, versus a measured normal run of roughly 2 minutes.
  This is an upper bound, not a claimed reduction in normal runtime.
- Dependabot groups compatible minor/patch version updates. npm has at most 2 open version
  PRs and Actions at most 1, replacing limits of 5 and 3. Weekly cadence, the existing
  seven-day cooldown and individual major upgrades remain. Security-update configuration
  is unchanged. Existing open PRs are not automatically closed by this change.

Full local `pnpm check` remains required. A skipped draft check never proves acceptance.
Batch implementation and report edits before changing a PR to ready for review.

## Deliberately retained

PostgreSQL integration, RLS isolation, browser checks and production packaging cover different
failure modes. Removing them from ready PRs would weaken the acceptance boundary for a small
runtime reduction and no current private-minute saving. Docs still receive validation; there
is no path-based skip that can accidentally bypass a required check.

Dependency installation took only four seconds in the measured run. There is no new cache
stack, matrix, scheduled workflow, separate classifier job or self-hosted runner to maintain.
The old uncommitted `codex/ci-optimizations` worktree was inspected and left untouched. Its
proposal to remove automatic PR checks was not applied. Changes are isolated from Sprint 8.1.

## Account budget follow-up

For the 3,000-minute budget, use the owner's August billing usage report grouped by private
repository, SKU/runner and workflow. Inspect repeated PR/main runs, intermediate agent pushes,
cron frequency, matrices and paid runner classes in the largest contributors first. Do not
extrapolate this public repository's elapsed runtime into billed account minutes, and do not
change repository visibility as a cost shortcut.
