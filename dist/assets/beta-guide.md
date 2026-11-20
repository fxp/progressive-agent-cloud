# Optional invitations and operations

The hosted service now accepts GitHub sign-in without an invitation. See [GETTING_STARTED.md](GETTING_STARTED.md) for public onboarding. The invitation mechanism below remains available for restricted self-hosted deployments. It runs on Cloudflare and cloud coding runners; no Mac daemon or ChatGPT subscription login is required. Each participant authorizes their own accounts and supplies their own Agent API key. The project is open source under Apache-2.0; you may independently self-host it.

## Join a restricted deployment

Ask the operator for an invitation for your **GitHub username**, not an email address. Open the complete private link and choose that GitHub account. The link is bound to GitHub's stable numeric account ID, expires after the configured period and can be redeemed once. If GitHub selected a different account, reopen the invitation and select the invited account. An accepted membership does not expire when its original invitation link expires.

The invitation token stays in the URL fragment and is submitted in a same-origin POST. It is not sent to GitHub or placed in OAuth query parameters. Only its hash is stored. Operators cannot retrieve the original link later; they can revoke it and create a replacement.

## Connect one working project

1. After GitHub login, readable GitHub Projects synchronize. If your requirements live in Linear, connect Linear and synchronize its projects. If no project appears, create a project in the source platform or authorize the correct workspace, then retry synchronization.
2. Select a meeting source. Feishu's scan flow creates an organization-owned app and separately requests Minutes TODO authorization. Organization policy may require administrator approval. Use the organization that owns the recording. A meeting notes Webhook is also supported; configure its private endpoint/key in your meeting service or integration tool.
3. Connect BigModel Managed Agent, Codex CLI or Claude Code. Codex requires a Responses-compatible HTTPS endpoint; Claude Code requires an Anthropic Messages-compatible HTTPS endpoint. Enter an available backend model ID. Your API key is encrypted and does not become another user's fallback. Subscriptions to local CLI products are not cloud API credentials.
4. Bind the imported project to a writable **test GitHub repository** and the selected Agent. Confirm exact permitted files, project aliases and validation commands. The installer adds a cloud workflow and encrypted execution secrets. GitHub Actions must be enabled. A repository is managed by one project at a time.
5. Create a new meeting with the project name, one small explicit requirement and observable acceptance criteria. For example, specify an exact read-only count, its empty result and existing behavior to preserve. The task should link the original meeting and source TODO to its Project, original Issue, cloud run and tested draft PR.
6. Review the generated code and tests before deciding whether to merge. Ambiguous, incomplete or conflicting requirements remain paused and require clarification. Automatic execution does not automatically merge PRs. The workbench currently retains `review_ready` after a PR is merged; follow the linked PR for its latest merge state.

## Recovery

- A connector with expired authorization asks for reconnection. A failed meeting source no longer blocks the same user's healthy independent source. Partial scheduler receipts identify the failing source, while healthy sources and their task queue continue. Transient source failures retry; authorization failures suspend only that source until reconnection.
- A failed development task links its cloud run even before a PR exists. Inspect that run, correct binding/validation settings as needed, then use task recovery. If a CLI intent has no saved artifact, confirm the prior run failed before explicitly restarting; the service will not silently launch another CLI.
- Replaying the same completed meeting reuses its tasks. A saved patch is checksummed and reused on retry. Draft PRs and result comments are keyed to the existing task.
- On a restricted deployment, revoking an invited member disables subsequent workspace access, queue enrollment and runner publication. Open registration independently admits accounts, so revoking an invitation does not disable access while open registration is enabled. Previously started external jobs may continue until their bounded timeout; revocation is not a remote cancellation API. A replacement invitation can re-admit that same account without deleting its own workspace.

## Operate invitations

Configure `PA_ADMIN_USER_IDS` with immutable internal IDs, for example `github:12345,github:67890`. Obtain numeric IDs from GitHub's user API or the existing user records. Use exact IDs rather than account names. Never assign this value from a browser request header.

Keep `PA_SIGNUP_MODE=allowlist` with the existing operator login allowlist. Invited members are separately admitted in D1, so no deployment is needed for each new participant. Existing explicitly allowlisted accounts and configured administrators retain their separate access when an invitation for them is revoked. Ordinary members cannot access the invitation ledger or create/revoke invitations.

Open **Workbench → 邀请管理**, enter a GitHub username and invitation lifetime, then copy the newly created private link. The operator sends it; the application does not automatically email or message anyone. The list shows pending, accepted, expired and revoked invitations without tokens. Revoking an old invitation does not revoke a newer replacement membership.

Apply `drizzle/0004_beta_invites.sql` before this release. Back up the database first. The additive migration preserves users, credentials, projects and tasks. It is included in the migration helper and the local test database.

`GET /api/health` reports the release version and basic database-schema, auth-configuration and Queue-binding readiness. An unhealthy response is HTTP 503 and contains no credentials or user data. This is a readiness check; actual Cron delivery is verified separately through per-user job/receipt records. After rollout, check two five-minute cycles and ensure existing task/run/PR/comment identities remain stable.

## Scope

GitHub is the current repository and PR provider. GitHub Projects and Linear supply project context; GitLab.com Issues has contract coverage but no new live account acceptance in this release. Codex and Claude Code have passed real cloud validation through GLM-compatible endpoints. Other backend models require their own validated credentials.

Feishu cross-organization recording access is not enabled by an invitation. Use the correct organization and an approved grant; the Webhook accepts source TODOs and cited notes where direct recording access is unavailable. Requirements review combines cited evidence, model-assisted checks, path/checksum boundaries and independent tests; it is not a formal proof for arbitrary future requirements.

Report failures through the repository issue templates. Include the task/run IDs and sanitized error code; omit keys, invitation links and confidential meeting content. Do not publish private account logs in public issues.
