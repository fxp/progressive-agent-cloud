# Connector plugins, API version 1

The server composes trusted, build-time plugins in `platform/connectors/builtins.mjs`. Add a module and register it with `createRegistry([plugin])`, or supply a registry to `new Platform(env, {registry})`. A plugin may implement several roles. The registry validates contracts at startup and rejects duplicate IDs or unsupported versions. This is not remote code installation or a browser plugin marketplace.

```js
const plugin = {
  manifest: {
    id: 'example-meeting', apiVersion: 1, name: 'Example meeting',
    kind: 'meeting', roles: ['meeting'], auth: 'webhook',
    capabilities: ['discover', 'read'],
  },
  meeting: {
    async discover({platform}, connection) {
      // Read an owner-scoped cursor and persist incoming events before processing.
      // Use platform.ingest(connection, normalizedMeeting).
    },
    async read(context, connection, item) {
      // Return source evidence, never generated acceptance conditions.
    },
  },
};
```

## Five role contracts

All methods receive `{platform, runnerSource?}` first. `platform.store.own(table, id, user)` enforces resource ownership. The complete method list is exported as `contracts` by `registry.mjs`; manifests are the workbench catalog.

| Role | Methods | Responsibility |
| --- | --- | --- |
| meeting | discover, read | Durable discovery and cited original TODO/notes evidence |
| project | list, createRequirement | Project catalog normalization and idempotent source requirement creation |
| agent | validate, credential, execution, completeJSON | Validate/encrypt a user's connection, describe execution, and perform structured evidence review |
| repository | repository, repositories, install, dispatch, runs, run, rerun, verify, baseline, publish, verification, refreshCredentials | Repository authority, installed runtime, verified patch publication and recovery |
| delivery | backfill | Idempotent result updates to the original requirement |

`list` returns `{externalId, name, description?, url, metadata?}` records. `createRequirement` returns `{id, url}`. `publish` returns `{pr, commit, tests, runUrl}`. Delivery currently belongs to the source project provider: it cannot accidentally write a GitHub result into an unrelated Linear issue. A GitHub connection implements project, repository and delivery roles independently.

Meeting normalization uses `{externalId, title, url, transcript, sourceKind, sourceTodos, sourceNotes}`. Each TODO has `{id, content}`. Each note has `{id, kind, title?, text}`. Webhook payloads expose the equivalent `todos` and `notes` fields; see [MEETING_WEBHOOK.md](MEETING_WEBHOOK.md). Preserve source IDs and exact evidence quotes. Never synthesize new TODOs from contextual notes. Incomplete or conflicting evidence pauses development.

Plugins may expose optional named `actions`. `POST /api/connectors/:id/actions/:action` supplies the authenticated `{user}` and enforces the same-origin mutation boundary before calling a registered action. A plugin must use that owner for all lookups. Secrets must never appear in responses, queue bodies or manifests. OAuth registration remains an operator integration: adding an `auth: oauth` manifest alone does not create provider OAuth endpoints.

## Coding Agent connections

BigModel Managed Agent retains its isolated hosted sandbox. Codex CLI and Claude Code run on a GitHub-hosted Linux runner inside a Docker container with no external network, dropped capabilities, read-only root filesystem and Git metadata, bounded resources, and separate temporary state. The controller archives the exact base and captures the final patch. Independent validation and publication run in separate jobs.

Codex uses Responses-compatible HTTPS gateways; Claude Code uses Anthropic Messages-compatible HTTPS gateways. Set the API key, base URL and model in the Agent connection form. The default endpoint allowlist permits OpenAI, Anthropic and BigModel. Operators can add exact gateway hosts with `PA_AGENT_ALLOWED_HOSTS`; loopback/HTTP URLs are rejected because a cloud runner cannot use a Mac-local proxy. The actual CLI and selected backend model are separate choices; connecting a GLM model does not run an OpenAI or Anthropic model.

A host-side Unix-socket model proxy holds the upstream API key. The container receives only an ephemeral proxy credential, can call only the selected protocol's model endpoint, and cannot change the configured model. Repository, platform and upstream model credentials are not mounted into the coding container. The proxy does not expose provider-managed web tools. CLI packages and the base container image are pinned in source. A trusted bootstrap installs Git, ripgrep, patch, Python and CA certificates before model access; the controller executes the resulting immutable image ID. Package installation and the pinned Claude Code native installer run outside the coding container with a scrubbed environment.

CLI invocation intents are persisted before launch. A saved, checksummed patch is reused on retry; an interrupted intent without a saved artifact pauses for reconciliation. An explicit restart requires a confirmed failed repository run and preserves the rejected run and intent history. Evidence-based correction resumes the saved CLI session under the same task and base. PR branches and result comments remain task-keyed. Runtime workspaces and CLI packages are removed before artifacts are uploaded; private diagnostic artifacts retain only bounded output and the proposed change.

`connectors.test.mjs` includes a plugin implementing all five roles without built-in provider calls, verifies ambiguous TODOs pause, and replays the complete workflow twice. Model-proxy tests verify authentication, fixed upstream destination/model, credential confinement and tool restrictions. These contract tests are distinct from live provider acceptance.
