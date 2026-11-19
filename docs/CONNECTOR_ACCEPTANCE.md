# Connector plugins and coding Agent acceptance

A new synthetic meeting on 2026-11-20 tested four original Feishu AI-generated TODOs across two existing, independently bound projects. The audio contains fictional content only. Feishu generated native TODOs and chapters. The workbench's authorized organization differed from the recording's organization, so direct artifact access returned `feishu_api_2091005`. The actual native TODOs, native chapters and explicitly labeled original recording-generation script were submitted through the existing meeting Webhook. The script preserves exact field names, numbers and exclusions omitted or mistranscribed in the AI summary. This is not a claim that a cross-organization Feishu permission failure was bypassed.

| TODO | Project / coding CLI | Result |
| --- | --- | --- |
| Read-only normal-priority total | Relay Desk / Codex 0.170.0 | Only `priority === "normal"`; total remains 2 in both existing views, 0 for empty input |
| Read-only completed total | Sprint Desk / Claude Code 2.1.328 | Only `done === true`; total is 1, 0 for empty input; unfinished total and original order remain |
| Automatically organize tasks | Relay Desk; behavior unspecified | Paused for acceptance clarification; no development Issue, session, run or PR |
| Bulk processing | Project and behavior unspecified | Paused for project and acceptance clarification; no guessed repository or development |

Both coding CLIs used GLM 5.3 through BigModel's Responses / Anthropic-compatible HTTPS endpoints. They did not use ChatGPT subscription login, Claude subscription login, a Mac-local gateway, or OpenAI / Anthropic models. Cloudflare persisted and coordinated the tasks; GitHub-hosted Linux runners executed the CLIs in isolated containers. Separate jobs applied and tested the patch, then the Worker checked the installed workflow / runner, run identity, base, checksums, cited evidence and exact submitted files before publishing one draft PR and one original-Issue result comment per clear task.

Codex produced 27 passing project tests; Claude Code produced 13. Independently reapplying both authentic cloud artifacts passed both suites. Their patch checksums and exact changed-file digests matched publication review records. All quoted criteria matched submitted source records. Browser checks verified exact counts in both Relay Desk views, empty input, original ordering, unchanged existing totals, exactly two Relay Desk filter buttons and no Sprint Desk controls.

Early adapter integration failures were retained in execution history. Codex required local namespace tool support, blocking native stdout pipes, the correct pinned package binary path and standard development tools; Claude Code required its pinned official native installer. Explicit failed-run restarts kept the same task, source Issue and logical session. Those intentional configuration retries are distinct from post-completion replay. Incomplete CLI intents pause for reconciliation; completed, checksummed artifacts are reused without launching another CLI.

The source suite contains 133 passing tests, including an extension plugin implementing all five roles without built-in provider calls, owner isolation, ambiguous requirements, repeated completion, gateway validation, both CLI reasoning protocols, intent reconciliation and constrained model proxies. These tests are distinct from the real account execution above.

Two actual post-completion Cron cycles at 2026-11-20 01:20 and 01:25 (Asia/Shanghai) completed successfully. Both D1 job and receipt records report `ingested: 0`, `webhookMeetings: 0` and `processed: 0`. All four task identities, statuses, source requirements, logical sessions, run IDs, patch digests and results remained unchanged. Each completed task retained exactly one PR and the same single result-comment ID; the two unclear TODOs retained no development artifacts. Same-event delivery was separately replayed twice and returned `completed / duplicate=true`.

Native GitLab authorization, non-GitHub repository adapters, arbitrary remote plugin installation and shared-team permissions remain outside this acceptance. Evidence review combines model-assisted semantic checks with deterministic boundaries and independent tests; it is not a formal guarantee for all future requirements.
