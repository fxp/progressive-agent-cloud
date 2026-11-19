# Progressive Agent

Turn meeting decisions into reviewed code. Connect meeting notes through Feishu or a Webhook, and your own GitHub, Linear or GitLab.com projects, bind a project to a repository and a selected coding Agent, and receive a tested draft pull request linked back to the original requirement.

[Hosted invited beta](https://progressive.xiaopingfeng.com/app) · [Beta guide](docs/BETA_GUIDE.md) · [Self-hosting](docs/SELF_HOST.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md)

## Start using it

1. Open your account-bound invitation for first access, then sign in with GitHub. Readable GitHub Projects synchronize automatically. Self-hosted deployments can choose their own signup policy.
2. Authorize Feishu or create a meeting notes Webhook. Connect Linear or GitLab.com Issues if your requirements live there.
3. Connect BigModel Managed Agent, Codex CLI or Claude Code with your own API key. Codex and Claude Code support compatible model gateways; choose the base URL and model explicitly.
4. Select an imported project, bind its writable GitHub repository and Agent, review the validation commands and allowed files, and save. The installer adds the cloud workflow and encrypted repository secrets.
5. Scan-created Feishu connections discover new meetings generated after authorization every five minutes and use their AI-generated TODOs. Legacy configured connections can also use transcript mode. Explicit, unambiguous requirements enter development automatically when that project enables automatic execution.

BigModel edits a Git bundle in an isolated cloud sandbox; Codex and Claude Code run in a network-isolated Docker container on a GitHub-hosted Linux runner. A separate GitHub runner applies the patch and runs your validation commands without model or publication credentials. After verification, a draft PR and its test links are written back to the original GitHub, Linear or GitLab issue. A draft PR waits for human review; it is not automatically merged.

## Self-host

Requires Node.js 22.13+ (24+ recommended), a Cloudflare account with Workers, D1 and Queues, and a GitHub OAuth application. Feishu and Linear applications are optional when those sources are not used. The deployment owner configures shared OAuth applications once; individual users authorize their own accounts and supply their own Agent key.

```sh
npm ci
npm test
npm run build
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler d1 create progressive-agent-cloud
npx wrangler queues create progressive-agent-user-jobs
npx wrangler queues create progressive-agent-user-jobs-dlq
# Insert the returned D1 database ID in wrangler.jsonc.
npm run db:migrate
# Configure runtime secrets using the guide below.
npm run deploy
```

Follow [SELF_HOST.md](docs/SELF_HOST.md) for callback URLs, permissions and secret configuration. No Mac process, local daemon or OpenAI login is involved in production.

## What is implemented

- Private workspaces identified by stable GitHub user IDs; account-bound, single-use beta invitations with operator revocation, or self-hosted open signup / allowlist.
- Per-user Feishu OAuth with PKCE, offline token renewal and native cloud meeting discovery.
- GitHub Projects and Linear project import, repository binding, original issue creation and result comments.
- Per-user encrypted Agent keys; installed repository secrets never use another user's key.
- A Cloudflare Queue job for each user, independent retries and a dead-letter queue.
- Durable meeting receipts, task leases, execution/session reconciliation and idempotent PR/result comments.
- Cited acceptance conditions supplemented from meeting notes, independent grounding and code reviews, and one bounded correction without creating another task or Agent session.
- Repository claims prevent two workspaces from overwriting one repository's execution secrets.
- Onboarding, automatic progress refresh, manual recheck, reauthorization and disconnect controls.

Supported execution adapters are BigModel Managed Agent, Codex CLI and Claude Code. Five versioned plugin roles cover meeting sources, project management, Agents, repositories and result delivery; see [CONNECTOR_PLUGINS.md](docs/CONNECTOR_PLUGINS.md). Each repository is managed by one project. Cross-provider project merging, shared-team roles, additional repository adapters, native meeting-vendor webhooks and PR-merge lifecycle updates are future work.

Feishu custom apps can authorize only users within their published availability. The scan onboarding flow creates an organization-owned app without users copying credentials, subject to company policies. Serving unrelated organizations through one shared application requires Feishu Store approval; self-hosters can also configure their organization app. The UI also supports user-owned OAuth applications. Linear's hosted OAuth app must have public availability to support other workspaces.

## Development

```sh
npm run build
npm run preview  # loopback-only development identity, never a production auth fallback
npm test        # built-in SQLite, provider mocks and real Git subprocesses; no API keys required
npm run build
npm run validate
```

Tests distinguish mocked provider orchestration from live account authorization. They cover two users sharing one database, foreign-resource denial, per-user model credentials, repository claims, OAuth renewal/application binding, queue failure isolation, replay and real patch verification.

Apache-2.0. See [LICENSE](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Additional Connectors

- Meeting notes Webhook: accepts source TODOs and cited notes from other meeting systems, persists events and processes them through the cloud queue. Owner-scoped credentials, rotation, conflict detection and status API are available. See [docs/MEETING_WEBHOOK.md](docs/MEETING_WEBHOOK.md).
- GitLab.com Issues: a personal access token connects project discovery, source Issue creation and result comments to an existing GitHub Repo / BigModel binding. Contract and recovery tests pass; real GitLab account acceptance remains pending. See [docs/GITLAB.md](docs/GITLAB.md).

Multi-project routing uses TODO evidence before meeting-level context. Ambiguous, omitted or conflicting TODOs remain paused with a clarification prompt. Meetings cannot silently supply a guessed project or extra feature.

Multi-project validation details: [docs/MULTI_PROJECT_ACCEPTANCE.md](docs/MULTI_PROJECT_ACCEPTANCE.md).

Plugin / Codex / Claude Code live acceptance: [docs/CONNECTOR_ACCEPTANCE.md](docs/CONNECTOR_ACCEPTANCE.md).
