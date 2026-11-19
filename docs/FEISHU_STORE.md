# Shared Feishu Store Connector

The Store integration is opt-in and requires a real Feishu Store application. It is not a way to extend a personal or organization-owned custom app to unrelated companies. End users should authorize the operator's shared app, then connect their own project providers and Agent key. Company administrators may still need to install the app and approve advanced permissions.

## Current rollout status

The implementation includes encrypted HTTP event verification, durable app tickets, tenant installation state, a per-user Minutes inbox, user OAuth and user-specific event subscription. Tests use local D1-compatible SQLite and mocked provider APIs. They do not establish Store eligibility, successful installation, actual event availability, or successful cross-organization execution.

The pilot Store app has a test version. Public Store availability and a real Minutes-generated event have not been verified. Keep `PA_FEISHU_STORE_ENABLED` unset until the release checks below pass. Existing custom-app credentials continue to operate independently.

## Discovery modes

| App type | How new meetings arrive | Historical bootstrap |
| --- | --- | --- |
| Organization-owned custom app | Five-minute searches with the user's own grant | Latest readable meeting in the supported search window |
| Shared Store app | User subscription plus signed, encrypted `minutes.minute.generated_v1` events | No historical search |

The Feishu search API documents support for custom apps only. The official Node SDK exposes Minutes subscription and generated-event schemas, but this alone does not prove those capabilities are available to a given Store app. In the pilot console, the generated event did not appear in the event chooser. Resolve that platform availability issue before advertising automatic discovery. Do not silently replace it with a request for a meeting link or an organization-owned app.

## Configure the shared app

Create the app under an eligible ISV organization in [Feishu Developer Console](https://open.feishu.cn/app). Enable the Web App capability with your `/app` page. Register the exact OAuth callback `https://YOUR-ORIGIN/api/oauth/feishu/callback`.

Request these user scopes: `minutes:minutes.basic:read`, `minutes:minutes.transcript:export`, `offline_access`. Do not request `minutes:minutes.search:read` for the Store flow. Publish the scopes to the selected test version or released version. Confirm that user-info identity lookup is allowed and that OAuth returns a refresh token.

Configure an Encrypt Key and Verification Token in Events and Callbacks. Set these Worker secrets without committing values:

| Secret | Value |
| --- | --- |
| PA_FEISHU_STORE_CLIENT_ID | Shared Store App ID |
| PA_FEISHU_STORE_CLIENT_SECRET | Shared Store App Secret |
| PA_FEISHU_STORE_VERIFICATION_TOKEN | Console Verification Token |
| PA_FEISHU_STORE_ENCRYPT_KEY | Console Encrypt Key |

Apply migration `0002_feishu_store.sql` before deploying. Set event delivery to `https://YOUR-REACHABLE-DOMAIN/api/webhooks/feishu`. This endpoint does not use browser cookies and can run on a custom domain while OAuth remains on the registered origin. Verify the URL from Feishu's console. Production event requests must be encrypted and signed; challenge requests must contain the configured verification token.

Add app lifecycle events `app_open`, `app_status_change`, and `app_uninstalled`. Confirm app-ticket delivery. Add `minutes.minute.generated_v1` under user subscriptions **only if Feishu exposes it for this app**, then validate `POST /open-apis/minutes/v1/minutes/subscription` using the authorized user's token and `{event_type:"minutes.minute.generated_v1"}`. Missing or restricted capabilities are release blockers, not a successful authorization state.

Use the console's version management to create a test version and assign a test enterprise. An administrator must first enable the app in that enterprise. A developer being able to create a Store app does not imply that developer has tenant-administrator rights.

While the shared app is still gated, a signed-in pilot user can explicitly start `/api/oauth/feishu/start?app=store`. Existing Feishu connections with a different app-scoped Open ID require explicit disconnect before changing accounts. Do not migrate all existing users to an unverified Store app. After test and Store review gates pass, set `PA_FEISHU_STORE_ENABLED=true` to make new default authorizations use it. Saved grants retain their original OAuth client for refresh.

## Processing and recovery

Events route only when app ID, tenant key and subscriber Open ID match an enabled user's connected source. The backend stores each event receipt once and inserts one inbox row per connection and Minute. Queue delivery triggers a user job; the five-minute Cron also drains the durable inbox if a queue send was missed. An empty or unavailable transcript stays pending and is retried. Task and delivery receipts preserve downstream idempotency.

If subscribing fails temporarily, the OAuth grant remains encrypted and the next source scan retries the subscription before reading the inbox. An explicit missing-permission response asks for administrator approval. Other subscription failures are shown separately rather than being mislabeled as administrator errors.

Pause and uninstall events affect only the matching app and tenant. Uninstall drops the stored local user grant, and runner endpoints reject publication after the source is disabled. Reinstallation does not restore an old credential automatically. Already started remote jobs may continue until their timeout; requests to publish must pass the current tenant checks.

## Release checks

1. Confirm the callback URL passes Feishu's real encrypted challenge.
2. Verify signed app-ticket and lifecycle delivery using the actual platform event formats. A replay must not change results, and delayed enable events must not undo a later uninstall.
3. Enable the test version as a tenant administrator. Complete real OAuth and user subscription; verify the source is connected and subscription active.
4. Generate a new synthetic meeting in the test enterprise. Confirm the actual generated event enters exactly one user's inbox. Do not use a manually injected webhook as evidence of platform discovery.
5. Verify the task matches the bound project, the user's Agent runs in the cloud, independent tests pass, a draft PR is created, and the original issue receives the exact delivery links.
6. Observe two additional scheduled rounds with stable meeting/task/session/PR/comment counts.
7. Repeat with an unrelated organization's authorized test user; test revocation without disturbing the first tenant.
8. Complete truthful Store listing, privacy/data handling, pricing and service-contact information; submit Store review. Enable public Store authorization only after approval and availability checks.

Meeting transcripts are sent to the selected model service for extraction; code tasks run through BigModel and GitHub Actions. OAuth grants and Agent keys are encrypted at rest in D1. Task evidence and delivery metadata persist after a Connector disconnect. Repository secrets or remote artifacts already created need provider-specific cleanup. Describe these actual behaviors in the published privacy notice; do not claim full account deletion or automatic external cleanup without implementing and verifying it.

## Official references

- [Feishu application publishing and test versions](https://open.feishu.cn/document/uMzNwEjLzcDMx4yM3ATM/uUjMyUjL1IjM14SNyITN)
- [Minutes search API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/minutes-v1/minute/search)
- [Official Node SDK](https://github.com/larksuite/node-sdk)
- [Member installation and administrator approval](https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/platform-overveiw/develop-process/configuring-employee-review-free-installation)
