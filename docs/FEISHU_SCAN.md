# Scan to connect Feishu

This opt-in workbench flow automates creation of a user-owned custom app. It does not require a Store listing or manual copying of App ID and Secret. It does not bypass the user's company policies or eliminate administrator approvals for controlled permissions.

## User flow

1. Sign in to the workbench and select **扫码开通飞书连接**.
2. Follow the official Feishu link, select the appropriate account/organization, and confirm creation of the dedicated app and declared permissions.
3. Return to the workbench and start personal-data authorization. Confirm it in Feishu, then return. The backend uses the device authorization flow also used by the official CLI; no custom callback is required.
4. A connection becomes active only after the returned identity matches the registering user, all required scopes are granted, and a refresh token is present. An existing connection stays in place until then.
5. Connect an Agent and bind a project/Repo. The cloud scheduler discovers new meetings generated after the new connection's enrollment. Historical meetings are not bootstrapped by this flow.

New scan connections default to meeting TODOs. The four requested user scopes are `minutes:minutes.basic:read`, `minutes:minutes.search:read`, `minutes:minutes.artifacts:read`, and `offline_access`. This mode calls the official Minutes AI artifacts endpoint. Unfinished `minute_todos` are the only task anchors; summary and chapter records can supply missing, explicitly stated acceptance constraints for the same feature. The transcript field is discarded. Only selected, validated quotations are persisted with each task and sent to the coding Agent. The AI-artifact scope itself is broader than TODO-only access. Existing transcript-mode setups keep their explicit mode and can select **改用会议纪要待办** without creating another app. The app-creation template is minimal and does not request `application:application:patch` or configure event delivery. Background discovery uses the existing five-minute Cloudflare Cron/Queue pipeline and user-scoped Minutes search.

## Cloud state and security

Apply migration `0003_feishu_bootstrap.sql` before deployment. The normal GitHub login/session and origin checks protect every start, poll, and authorize request. Setup rows belong to one workspace user. Device codes, app credentials, and intermediate tokens are encrypted in D1 using the existing encryption key and a setup-specific authenticated context; responses expose only public verification links, state, app ID, and missing scope names.

Registration uses one durable setup per user. Reopening the dialog resumes the same pending or created application instead of creating duplicates. Server polling respects the provider interval, including slow-down responses, and is serialized with a lease. App credentials are saved before the next network step. Browser closure does not delete them; reopen the flow to continue. Do not retain or expose the one-time device code in client state or logs.

Registration and personal-data authorization are separate consent steps. Device authorization does not establish an always-on connection if the server omits a refresh token. Scope checks reject partially granted permissions. Missing business scopes are shown as **waiting for company approval**, with a retry-after-approval action that reuses the created app. Unusable partial grants are discarded locally; they do not replace the existing connection.

After successful identity and grant validation, the source retains its existing connection row ID, saves its new OAuth client for future refresh, resets the discovery cursor when changing identity/app, and preserves task/delivery receipts. Existing projects and repository bindings are not reassigned. Bound runners keep using current platform authorization, so no local daemon is required.

## Real pilot result and limits

A company member without tenant-administrator access successfully created an app through the official scan flow. Transcript export was held for company approval, so its partial grant was correctly rejected. The same member then authorized AI artifacts without administrator approval. The platform verified the registering identity, complete TODO scopes, and a refresh token before activating the new app's connection. This result is specific to the tested organization; company policies may differ.

A new synthetic meeting was uploaded after this authorization. Native five-minute cloud discovery read its three Feishu-generated TODOs, combined implementation/testing/PR into one feature task, matched its bound project, created the original issue, and dispatched a BigModel cloud session. No transcript export or manual meeting injection was used. The cloud Agent completed the feature, an independent GitHub job passed validation, and publication produced one draft PR with a result comment on the original issue. Eight feature tests passed; browser checks of the downloaded patch confirmed all → pending → completed → all counts of 3 → 2 → 1 → 3. Two subsequent five-minute cloud checks completed successfully. Both retained exactly one meeting task, the same Agent session and run (attempt 1), one draft PR and one unchanged result comment; durable meeting receipts still contained one task. These are business replay checks, separate from CI runs.

Feishu-generated TODOs can omit detail present in the meeting. In this pilot they preserved the feature and test categories but omitted exact sample counts and some UI expectations. The product must not invent missing requirements. Keep the source meeting link, TODO IDs and acceptance citations for traceability. The grounding review sends incomplete, contradictory or unrelated evidence to `needs_info` instead of development.

An early probe requested application-management permission for a callback. The final device flow does not require it; do not approve that obsolete request. Developer-assistant AppLink IDs are not the registered application's identity; use the identity verified by the token exchange.

## Acceptance

- Verify the complete selected scope set, refresh token, registering identity, and correct company. Reopen after browser restart to verify recovery.
- Generate one synthetic meeting with an explicit bound project and a single feature requirement. Let native cloud discovery ingest it without manual meeting injection.
- Verify one task, the matched project, the original issue, one cloud Agent session, independent tests, a draft PR, and an exact result backfill.
- Observe two subsequent scheduled rounds. Meeting/task/session/PR/result-comment counts must stay stable. Keep this check in the active test session rather than creating a background reminder.
- Confirm the first user's grants and tasks remain isolated. Validate token refresh in the cloud before claiming sustained unattended use.

## Second-organization acceptance

A second organization was tested from an empty, isolated cloud deployment using an existing GitHub identity. Its current Feishu identity is the organization's Founder, so this is **not another ordinary-member acceptance result**. Production users, grants and bindings were kept separate; no historical credentials or task rows were copied into the test workspace.

First-time GitHub login imported readable projects, the product's scan flow created a new dedicated Feishu app, and device consent activated the AI-artifact grant for the second tenant. Repo/Agent binding installed a cloud runner. Native scheduled discovery then created one task from a newly uploaded synthetic meeting, matched its project, and completed BigModel development, independent validation, a draft PR and original-issue backfill. Ten implementation tests passed. Two subsequent five-minute scheduled checks completed successfully with the same task, Agent session and workflow run (attempt 1), one draft PR and one unchanged result comment. Source-scan timestamps advanced in both rounds. Existing production connection identities and task results remained unchanged.

The content check found a real limitation: the original meeting requested only All and High priority options, while the generated TODO omitted that restriction. The Agent added Normal as well. Default/filter/reset counts and empty-state behavior passed, but exact agreement with the meeting's option set **failed**. Implementation test success does not establish requirement fidelity. This historical TODO-only result motivated the evidence-grounding fix below; the original draft remains part of the test record.

## Grounding missing acceptance conditions

New TODO tasks use two checks before coding: extraction must anchor each task to existing TODO IDs and quote acceptance conditions verbatim from those TODOs or the same meeting's summary/chapters; an independent grounding pass checks feature scope, completeness, conflicts and exclusions. The server derives the task goal from the original TODO text rather than a model-generated rewrite. Unquoted conditions and tasks invented solely from notes are rejected. Missing or uncertain evidence waits in `needs_info`, including after project binding.

The coding specification carries these citations and explicitly forbids expanding closed option sets or treating repository data as a new feature request. After the independent GitHub validation job succeeds, publication performs another model review of the proposed files against the cited requirements. A rejected or unavailable review cannot publish a PR. The review compares the proposed files with their original base, so existing styles and data are not treated as new requirements. An approved result is cached only for the same patch checksum and exact file digest. A failed code review can trigger at most one correction under automatic execution: it preserves the task, original issue and Agent session, records the rejected run, dispatches a new run on the current installed runner, and refuses the stale patch. Dispatch uncertainty is reconciled instead of blindly repeated. Cancelled runs are not repaired automatically. A second rejection stops for review. Tests passing alone do not authorize publication.

The reviews use the connected user's model key. They are semantic checks, not a formal guarantee of correctness. Source records remain untrusted data, and human-confirmed requirements are labeled separately from Feishu citations. No transcript-export permission is added.

## Official implementations

- [Node SDK app registration](https://github.com/larksuite/node-sdk/blob/main/README.zh.md#一键创建应用)
- [CLI device authorization](https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go)
- [CLI refresh-token prerequisites](https://github.com/larksuite/cli/blob/main/internal/auth/no_refresh_token.go)

- [Minutes AI artifacts API](https://open.feishu.cn/document/minutes-v1/minute/artifacts)
