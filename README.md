# Progressive Agent

Turn meeting decisions into reviewed code. Connect your own Feishu, GitHub and Linear accounts, bind a project to a repository and BigModel Managed Agent, and receive a tested draft pull request linked back to the original requirement.

[Hosted workbench](https://progressive.xiaopingfeng.com/app) · [Self-hosting](docs/SELF_HOST.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md)

## Start using it

1. Sign in with GitHub. Readable GitHub Projects synchronize automatically.
2. Authorize your Feishu account. Connect Linear if your requirements live there.
3. Connect your own BigModel API key with model and Managed Agent access.
4. Select an imported project, bind its writable GitHub repository and Agent, review the validation commands and allowed files, and save. The installer adds the cloud workflow and encrypted repository secrets.
5. The latest readable meeting is checked. Subsequent new meetings are discovered every five minutes. Explicit, unambiguous requirements enter development automatically when that project enables automatic execution.

BigModel edits a Git bundle in an isolated cloud sandbox. A separate GitHub runner applies the patch and runs your validation commands without model or publication credentials. After verification, a draft PR and its test links are written back to the original GitHub or Linear issue. A draft PR waits for human review; it is not automatically merged.

## Self-host

Requires Node.js 22.13+ (24+ recommended), a Cloudflare account with Workers, D1 and Queues, and GitHub/Feishu OAuth applications. Linear is optional. The deployment owner configures shared OAuth applications once; individual users authorize their own accounts and supply their own Agent key.

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

- Private workspaces identified by stable GitHub user IDs; optional open signup or account allowlist.
- Per-user Feishu OAuth with PKCE, offline token renewal and native cloud meeting discovery.
- GitHub Projects and Linear project import, repository binding, original issue creation and result comments.
- Per-user encrypted Agent keys; installed repository secrets never use another user's key.
- A Cloudflare Queue job for each user, independent retries and a dead-letter queue.
- Durable meeting receipts, task leases, execution/session reconciliation and idempotent PR/result comments.
- Repository claims prevent two workspaces from overwriting one repository's execution secrets.
- Onboarding, automatic progress refresh, manual recheck, reauthorization and disconnect controls.

First release supports Feishu meetings, GitHub repositories and BigModel Managed Agent. Each repository is managed by one project. Cross-provider project merging, shared-team roles, additional Agent adapters, provider webhooks and PR-merge lifecycle updates are future work.

Feishu custom apps can authorize only users within their published availability. A hosted service serving unrelated organizations needs a distributed/store application approved by Feishu; self-hosters can use their own organization app. The UI also supports user-owned OAuth applications. Linear's hosted OAuth app must have public availability to support other workspaces.

## Development

```sh
npm run preview  # loopback-only development identity, never a production auth fallback
npm test        # built-in SQLite, provider mocks and real Git subprocesses; no API keys required
npm run build
npm run validate
```

Tests distinguish mocked provider orchestration from live account authorization. They cover two users sharing one database, foreign-resource denial, per-user model credentials, repository claims, OAuth renewal/application binding, queue failure isolation, replay and real patch verification.

Apache-2.0. See [LICENSE](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
