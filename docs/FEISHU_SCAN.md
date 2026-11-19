# Scan to connect Feishu

This opt-in workbench flow automates creation of a user-owned custom app. It does not require a Store listing or manual copying of App ID and Secret. It does not bypass the user's company policies or eliminate administrator approvals for controlled permissions.

## User flow

1. Sign in to the workbench and select **扫码开通飞书连接**.
2. Follow the official Feishu link, select the appropriate account/organization, and confirm creation of the dedicated app and declared permissions.
3. Return to the workbench and start personal-data authorization. Confirm it in Feishu, then return. The backend uses the device authorization flow also used by the official CLI; no custom callback is required.
4. A connection becomes active only after the returned identity matches the registering user, all required scopes are granted, and a refresh token is present. An existing connection stays in place until then.
5. Connect an Agent and bind a project/Repo. The cloud scheduler discovers new meetings generated after the new connection's enrollment. Historical meetings are not bootstrapped by this flow.

The four requested user scopes are `minutes:minutes.basic:read`, `minutes:minutes.search:read`, `minutes:minutes.transcript:export`, and `offline_access`. The app-creation template is minimal and does not request `application:application:patch` or configure event delivery. Background discovery uses the existing five-minute Cloudflare Cron/Queue pipeline and user-scoped Minutes search.

## Cloud state and security

Apply migration `0003_feishu_bootstrap.sql` before deployment. The normal GitHub login/session and origin checks protect every start, poll, and authorize request. Setup rows belong to one workspace user. Device codes, app credentials, and intermediate tokens are encrypted in D1 using the existing encryption key and a setup-specific authenticated context; responses expose only public verification links, state, app ID, and missing scope names.

Registration uses one durable setup per user. Reopening the dialog resumes the same pending or created application instead of creating duplicates. Server polling respects the provider interval, including slow-down responses, and is serialized with a lease. App credentials are saved before the next network step. Browser closure does not delete them; reopen the flow to continue. Do not retain or expose the one-time device code in client state or logs.

Registration and personal-data authorization are separate consent steps. Device authorization does not establish an always-on connection if the server omits a refresh token. Scope checks reject partially granted permissions. Missing business scopes are shown as **waiting for company approval**, with a retry-after-approval action that reuses the created app. Unusable partial grants are discarded locally; they do not replace the existing connection.

After successful identity and grant validation, the source retains its existing connection row ID, saves its new OAuth client for future refresh, resets the discovery cursor when changing identity/app, and preserves task/delivery receipts. Existing projects and repository bindings are not reassigned. Bound runners keep using current platform authorization, so no local daemon is required.

## Real pilot result and limits

The pilot used a company member account without tenant-administrator access. Official app creation succeeded. The device-authorization page granted Minutes metadata and search while explicitly showing **transcript export under review**. The token was only partially scoped, and the platform refused to activate it. The old source grant stayed unchanged.

An earlier configuration probe requested app-management permission to set an OAuth callback. That permission also required review. The final flow removes that requirement entirely and uses device authorization. This does not remove the separate transcript-approval requirement observed in the company. The first pilot application may still have that earlier permission request pending; do not approve that management permission for this flow. Cancel the obsolete request through the application's authorized management process when available.

No new synthetic meeting was uploaded after this permission blocker, and no successful new meeting-to-PR result or two-round deduplication acceptance is claimed. The synthetic test audio is prepared privately. A full acceptance run must use the new app's own renewable grant and actual new Minutes; an older authorized custom app must not be substituted as proof.

## Acceptance after approval

- Reauthorize the existing scanned app; verify the four scopes, refresh token, registering identity, and correct company. Reopen after a browser restart to verify recovery.
- Generate one synthetic meeting with an explicit bound project and a single feature requirement. Let native cloud discovery ingest it without a manual meeting injection.
- Verify one task, the matched project, the original issue, one cloud Agent session, independent tests, a draft PR, and an exact result backfill.
- Observe two subsequent scheduled rounds. Meeting/task/session/PR/result-comment counts must stay stable. Keep this check in the active test session rather than creating a background reminder.
- Confirm the first user's grants and tasks remain isolated. Validate token refresh in the cloud before claiming sustained unattended use.

## Official implementations

- [Node SDK app registration](https://github.com/larksuite/node-sdk/blob/main/README.zh.md#一键创建应用)
- [CLI device authorization](https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go)
- [CLI refresh-token prerequisites](https://github.com/larksuite/cli/blob/main/internal/auth/no_refresh_token.go)
