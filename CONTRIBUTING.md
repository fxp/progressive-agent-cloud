# Contributing

Use Node.js 24 or newer, run `npm ci`, `npm test`, `npm run build`, and `npm run validate`. Keep provider adapters separate from task orchestration. Add meaningful tests for changes involving ownership, token refresh, retry, deduplication and publication. Tests must not call real providers or depend on personal accounts.

Append migrations rather than rewriting published schema. Preserve OAuth/credential context and do not add identity fallbacks in production. Queue payloads and browser responses must not contain secrets or full transcripts. Documentation should distinguish unit tests, contract tests and real-provider validation.

Propose new meeting, project or Agent adapters through an issue describing their capabilities and authentication requirements. Never silently fall back to another user's account, Agent key or project.
