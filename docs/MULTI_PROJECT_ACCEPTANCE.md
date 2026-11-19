# Multi-project meeting acceptance

A synthetic meeting tested two independently bound projects, five TODOs, and incomplete or conflicting decisions. No real customer conversation was used. The recording was uploaded to Feishu, but the account had no remaining AI-notes quota. Feishu returned `meeting_todos_not_ready`; it did not start invented work. The same synthetic meeting's explicitly prepared notes and TODOs were delivered through the new meeting Webhook. This is a real cloud execution test of that Connector, not a claim that Feishu generated native notes despite its quota.

| TODO | Project evidence | Expected behavior |
| --- | --- | --- |
| Read-only high-priority total | Relay Desk | Develop only that total; retain the existing two filter options |
| Read-only unfinished total | Sprint Desk | Count only `done === false`; preserve the existing list |
| Smarter reminders | Relay Desk; behavior unspecified | Pause and ask for trigger, channel, timing and expected behavior |
| Download button | Both projects mentioned; no decision | Pause for project and acceptance clarification; no export feature |
| Default view | Sprint Desk; contradictory proposals | Pause; neither proposal affects the independent confirmed count |

Both clear TODOs created one source Issue, used their own cloud task and Managed Agent session, passed independent GitHub validation and evidence review, created one draft PR each, and posted one result comment to their respective source Issue. The paused TODOs created no Issue, coding session, GitHub run or PR. Their exact clarification reasons appeared in the workbench.

Relay Desk passed 23 tests. Sprint Desk passed 7 tests. Independent local reapplication of the authentic patches passed both suites, and their patch checksums and exact changed-file digests matched the published review checkpoints. Browser checks verified exact labels, default counts, filter-independent totals, empty data, ordering and no extra controls. All citations were checked against the submitted source records.

The first Sprint Desk run was correctly blocked because the test binding used obsolete `src/` paths while the current fixture had root files. The binding was corrected to the five exact permitted files and an explicitly requested configuration retry reused the same task, original Issue, Agent session and patch. The failed run remains recorded and excluded from reconciliation. This was a deliberate correction before successful completion, not an accidental replay after completion.

Repeat delivery with the same event ID was accepted as a duplicate. Delivery with a different event ID but the same meeting URL reused all five original tasks. Cross-Connector deduplication is account-scoped; Feishu Minutes URL source parameters are normalized. Completed pre-upgrade tasks can be adopted without rewriting their status or payload. An interrupted ingestion blocks a competing delivery until its original receipt completes.

Post-completion scheduled observation passed at 2026-11-19 23:35:39 and 23:40:39 (Asia/Shanghai). Both exact Cron job IDs had completed D1 job and receipt records with `processed: 0`. All five task rows remained identical to the completion baseline, including sessions, run IDs, patch digests and timestamps. Both clear tasks still had exactly one PR and one result comment. The three unclear tasks still had no original Issue, session, run or PR. The platform suite passed 124 tests.

GitLab.com Issues is additionally implemented with encrypted personal access tokens, project synchronization, source Issue creation, PR-result comments and recovery tests. It has not yet passed a real GitLab account authorization/write-back test. GitHub remains the code repository and PR executor; native GitLab Merge Requests and self-hosted GitLab are not supported in this version.

Evidence review is a model-assisted semantic check plus deterministic source, path, checksum and independent test gates, not a formal proof for all future requirements.
