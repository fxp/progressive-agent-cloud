# Architecture

The Worker serves the landing page, authenticated workbench, OAuth callbacks and runner API. D1 stores users, connections, encrypted application settings, projects, repository claims, meeting receipts, tasks, jobs and leases. Cloudflare Cron enqueues ready users every five minutes. Cloudflare Queues processes each user independently, with explicit acknowledgment and retry.

The queue body contains only a version, job ID and user ID. Consumers re-read the user's enabled account and connections, then hold a user-specific lease. Feishu discovery and transcription use that connection's user token. Extraction uses that user's Agent key. State, projects, jobs and receipts are queried under the same user ID; another user's failure or project never becomes fallback context.

Native Feishu discovery initially checks the most recent readable meeting from the last seven days. Later discovery uses the enrollment cutoff, retaining bounded page offsets and a frozen search window while walking pages. Keeping the creation cutoff avoids skipping meetings that were indexed late. Durable receipts make replays reuse existing tasks.

Project matching uses a unique project name or alias. Ambiguous projects and incomplete requirements wait for confirmation. Binding a project can resolve that user's pending unassigned tasks. A repository claim is global across workspaces so another authorized collaborator cannot overwrite its runner credentials through this service.

Execution creates or locates an original issue before dispatch. The repository workflow clones a Git bundle in a credential-free Managed Agent sandbox. A separate GitHub job applies and tests the patch. Publication verifies the task/run relationship, installed workflow and runner hashes, base commit and patch checksum before creating a draft PR and commenting on the original issue.

The session cookie is signed, HttpOnly, Secure on HTTPS, SameSite=Lax and expiring. OAuth state is single-use, expiring and browser/user bound. Its encrypted envelope captures the application configuration used at authorization, so later settings changes cannot switch a code or refresh token to a different application. Credentials use AES-GCM with owner/connection context. Secrets are never returned to the browser or placed in queue messages.

The optional legacy exporter compatibility is restricted to an explicitly configured legacy owner. New installations do not need it or a deployment-level model credential. Per-user Feishu discovery is the default product path.

## Additional source adapters

The meeting notes Webhook authenticates with an owner-scoped, rotatable Bearer credential. The receiver stores a bounded source-evidence envelope in D1 before enqueuing processing; the queue contains only IDs. Webhook-only accounts do not require a Feishu grant. The status API returns only that endpoint's event and task links. Receipt digests reject altered same-ID payloads. An account-scoped canonical meeting URL and lease prevent cross-Connector duplicate extraction, including completed pre-upgrade tasks and interrupted original ingestion.

GitLab.com Issues uses an encrypted per-user Personal Access Token verified for `api` scope. It imports project catalogs and handles source Issue/result comments independently of the GitHub repository credential. The repository and PR execution path remains GitHub Actions plus BigModel. Real GitLab account acceptance is still pending; see [GITLAB.md](GITLAB.md).
