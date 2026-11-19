# Invited beta acceptance — 0.2.0-beta.1

Validated on 2026-11-20 (Asia/Shanghai). This release adds hosted invitation onboarding and source failure isolation to the previously validated cloud development loop.

## Automated checks

145 tests passed in the application and a clean public-source export. Build and Worker artifact checks passed. Tests cover a fresh account outside the allowlist, private workspace isolation, wrong-account redemption, preexisting browser sessions, expired/revoked links, concurrent revocation, re-admission, admin denial, queue/runner admission and independent meeting-source failures. No real third-person account is represented by those fixtures.

## Live invitation and gateway checks

An operator created an invitation through the workbench, and the existing pilot account accepted it through real GitHub OAuth. Reusing the consumed link returned HTTP 410. With that account removed from both the staging allowlist and administrator configuration, its workspace remained accessible (HTTP 200), admin listing and creation returned HTTP 403, and the admin navigation was hidden. This was a live existing-account admission test, not a new human account test.

Independent Codex Responses and Claude Code Anthropic-compatible structured requests succeeded with the configured GLM-5.3 HTTPS gateway. The probes had no BigModel connection and therefore could not use a Managed Agent fallback key. Prior real cloud development / test / draft-PR / backfill evidence is recorded in [CONNECTOR_ACCEPTANCE.md](CONNECTOR_ACCEPTANCE.md).

## Two actual Cron replay rounds

The invited ordinary-member policy remained active during both rounds. Exact Cloudflare scheduled job IDs and receipts were inspected; this was not a manually triggered replacement.

| Scheduled time (CST) | Job | Job / receipt |
|---|---|---|
| 2026-11-20 04:10 | `job-4b0887f0508af984e0f94b56739dd52edb49bcb2cf105fad8849e3bf31daf5b3` | completed / completed |
| 2026-11-20 04:15 | `job-28bb6ca843e185a312d2dc2705891cf0206d0081523f832c58a02a7b9e00aa6d` | completed / completed |

Across both rounds, four task identities and their project/original/run/session/result/checksum/revision fields remained unchanged. The two completed tasks retained the same successful GitHub run IDs and attempt numbers, one PR each and one result comment each with the same comment ID. The two ambiguous tasks stayed `needs_info` / `needs_project`, with no original Issue, Agent session or development run. No duplicate execution, PR, archive or result comment was observed in these rounds.

## Rollout and limits

Both hosted databases were backed up before the additive migration. Migration 0004 preserves existing users, encrypted credentials, projects and tasks. Operator-only configuration is restored after the staging acceptance; real invitation membership does not depend on a per-user allowlist deployment. The application and coding runners operate in the cloud, and no Mac service is required. Physical Mac power-off was not performed.

A genuinely new external participant still needs live onboarding with their own accounts, organization permissions, Repo and Agent key. Feishu cross-organization recording access is still governed by Feishu organization policy; cited notes / TODO Webhook remains an alternative where direct access is unavailable. Health readiness does not by itself prove Cron delivery. PRs require human review, and the workbench currently retains `review_ready` after merging; use the linked PR for its merge state.

No invitation tokens, keys, confidential meeting bodies or database backups are included in this public evidence.
