# Self-host Progressive Agent

Use one stable HTTPS origin for the workbench and all OAuth callbacks. Additional landing-page domains redirect `/app` and `/api` to this origin, except the authenticated Feishu event webhook, which can be served directly on a custom domain. Production runs on Cloudflare Workers, D1 and Queues; code execution runs on BigModel and GitHub Actions.

## Deploy infrastructure

Use Node.js 22.13+ (24+ recommended). Install with `npm ci`, then run `npm test && npm run build`. Copy `wrangler.example.jsonc` to `wrangler.jsonc`, change the Worker name and `PA_ORIGIN`, and sign in with `npx wrangler login`.

Create a D1 database and both queues using the commands in README. Replace the placeholder database ID. Queue names must match producer and consumer entries; names must be unique within your Cloudflare account. Use separate databases/queues/apps for staging and production.

Run `npm run db:migrate`. It checks whether the baseline schema exists, applies it only for an empty database, then applies the additive multiuser and Feishu Store migrations. Run before deploying this version; back up an existing database first. The migrations preserve existing rows. `npm run db:migrate -- --local` selects local D1. To use another config, set `WRANGLER_CONFIG`.

Generate two independent keys with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Store them using `npx wrangler secret put PA_SESSION_KEY` and `npx wrangler secret put PA_ENCRYPTION_KEY`. Preserve the encryption key: rotating it without re-encrypting stored rows makes credentials unreadable. Session-key rotation signs users out.

Set shared app secrets with `npx wrangler secret put NAME` for each variable below. Do not commit secret files or paste keys into issues.

| Variable | Purpose |
| --- | --- |
| PA_GITHUB_CLIENT_ID | Shared GitHub OAuth App client ID |
| PA_GITHUB_CLIENT_SECRET | GitHub OAuth secret |
| PA_FEISHU_CLIENT_ID | Feishu App ID |
| PA_FEISHU_CLIENT_SECRET | Feishu App Secret |
| PA_LINEAR_CLIENT_ID | Optional Linear OAuth client ID |
| PA_LINEAR_CLIENT_SECRET | Optional Linear secret |

Configuration vars in wrangler.jsonc: `PA_AUTH_MODE=github`, `PA_ORIGIN=https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev`, and `PA_SIGNUP_MODE=open` for public signup. For a private pilot, use `PA_SIGNUP_MODE=allowlist` plus `PA_ALLOWED_GITHUB_LOGINS=alice,bob`; missing signup mode also uses the allowlist. Keys identify accounts by immutable GitHub user ID, not email. A globally configured model key is not available to new users. Each user supplies their own BigModel key in the workbench.

Deploy with `npm run deploy`, open `/app`, and complete GitHub login, Feishu authorization and Agent setup. Linear is optional. Bind a project to a writable repository and save to install the runner.

## Register OAuth applications

For each callback below, replace `https://YOUR-ORIGIN` with the exact `PA_ORIGIN`. Avoid trailing slashes. The origin also protects POST requests and cookies.

### GitHub

Create an OAuth App at [GitHub developer settings](https://github.com/settings/developers). Set callback `https://YOUR-ORIGIN/api/oauth/github/callback` and homepage to your public landing page. The app requests `repo project workflow read:org offline_access`: it imports Projects, lists writable repositories, creates issues/PRs and installs workflows/secrets only in repositories the user binds. Organization policies and SSO may require approval. Do not present it as repository-scoped authorization; the OAuth token has the granted account scope.

### Linear

Create an OAuth app at [Linear API settings](https://linear.app/settings/api/applications). Callback: `https://YOUR-ORIGIN/api/oauth/linear/callback`. Request `read issues:create comments:create`. Enable public availability if other Linear workspaces should authorize it. The integration uses PKCE; it omits the client secret for this PKCE flow. Project imports and comments use the authorizing user's token.

### Feishu

The workbench now offers **Scan to connect Feishu**, backed by the official app-registration and device-authorization protocols. Users confirm application creation and separately authorize their own Minutes data; they do not copy app credentials or configure callbacks. This creates an organization-owned custom app rather than a shared Store app. New scan connections use meeting TODOs through the AI-artifact permission instead of transcript export. In the tested organization, a non-administrator member successfully authorized this mode, and native cloud discovery created and dispatched a task from a new meeting. Company policies still apply; TODO summaries may omit meeting details. See [scan onboarding](https://github.com/fxp/progressive-agent-cloud/blob/main/docs/FEISHU_SCAN.md).

There are two distinct discovery modes. A shared Store app is **not enabled by merely copying a custom app's scopes**. See [Feishu Store rollout](https://github.com/fxp/progressive-agent-cloud/blob/main/docs/FEISHU_STORE.md) for the opt-in implementation, platform checks, and remaining release gates.

#### Organization-owned custom app

The following manual configuration is an advanced fallback. The scan flow uses device authorization and does not need a redirect URL or application-management scope. Its completed connection enrolls only meetings generated after authorization, rather than importing historical meetings.

Create or configure an app in [Feishu Developer Console](https://open.feishu.cn/app). Add callback `https://YOUR-ORIGIN/api/oauth/feishu/callback` in Security Settings. Enable and publish these user scopes: `auth:user.id:read`, `minutes:minutes.search:read`, `minutes:minutes.transcript:export`, `offline_access`. User authorization must return a refresh token.

A custom app is available only within the organization's published availability. Serving unrelated organizations through one shared app requires Feishu's ISV/store-app qualification and review. Before that, use an organization-owned app: users can configure their own OAuth application in the Connector's advanced settings. Do not promise a shared personal custom app works across organizations.

The token endpoint defaults explicitly to `/authen/v2/oauth/token` with JSON and S256 PKCE, due to observed v3 PKCE compatibility errors. It does not retry an already consumed authorization code against another endpoint. To intentionally use v3 after validating provider compatibility, set `PA_FEISHU_TOKEN_VERSION=v3` before authorization. Authorized tokens remember their originating client configuration and version for refresh.

The service searches meetings owned by the authorizing Feishu identity. First enrollment checks the latest readable meeting within seven days; subsequent scans discover new meetings since enrollment. A saved search window, pagination offset and receipts preserve retries and late indexing within the seven-day window. Oversized/unavailable transcripts surface in Connector status.

## Cloud scheduling and execution

Cloudflare Cron runs every five minutes. It enqueues separate user IDs; a Queue consumer reads only that user's grants, source cursor, Agent key, projects and task receipts. The queue retries transient errors, then moves exhausted messages to the configured dead-letter queue. Monitor the dead-letter queue in Cloudflare and investigate failures before replaying them. Manual Check Now enqueues a user check and collapses repeated clicks within one minute.

GitHub Actions must be enabled on bound repositories and the user must be able to install workflows and repository secrets. The installer writes `.github/workflows/progressive-agent.yml`, its runner script and the selected user's encrypted execution secrets. Repositories containing the legacy Focus Board relay need an explicit migration before installation. One repository may be owned by one project at a time; release its binding before assigning it elsewhere.

Use explicit project names/aliases and concrete acceptance criteria in meetings. Ambiguous project matches wait for user confirmation. Configure validation commands that actually exercise the product. Allowed paths constrain code modifications and reject workflow/environment changes from generated patches. A draft PR is created after verification and is never automatically merged.

Disconnect stops future dispatch and invalidates runner access. It does not cancel a remote sandbox or workflow already started; those have bounded timeouts. Unbind has an active-run guard. Reauthorization and API-key changes must be completed by the account owner. Updating an Agent key refreshes its repository secrets; failed repositories must reinstall the runner.

## Verify a deployment

1. Verify an unauthenticated `/api/state` returns a login response rather than workspace data.
2. Sign in as account A, authorize providers, connect an Agent and bind a test repository.
3. Make a synthetic meeting with a small feature requirement. Verify the original issue, task, Agent session, independent tests, draft PR and result comment agree.
4. Observe two additional Cron rounds and confirm counts/links remain stable.
5. Repeat with account B and a different repository. Confirm each account sees only its own projects, grants, tasks and scheduler status. Confirm an attempt to claim A's repository is rejected.
6. Disconnect one account and confirm the other still progresses. Close the local machine; production uses only cloud services.

`npm test` covers isolation and orchestration with mocked provider APIs and real local Git operations. These tests do not substitute for two real users authorizing their respective accounts.
