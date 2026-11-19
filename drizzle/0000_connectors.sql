CREATE TABLE pa_connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, identity TEXT NOT NULL DEFAULT '{}', credential TEXT, synced_at INTEGER, error TEXT, UNIQUE(user_id,provider));
--> statement-breakpoint
CREATE TABLE pa_settings (user_id TEXT NOT NULL, provider TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,provider));
--> statement-breakpoint
CREATE TABLE pa_oauth (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE pa_projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, connection_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, url TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL, binding TEXT, synced_at INTEGER NOT NULL, UNIQUE(connection_id,external_id));
--> statement-breakpoint
CREATE TABLE pa_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, meeting_key TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX pa_tasks_queue ON pa_tasks(status,updated_at);
--> statement-breakpoint
CREATE TABLE pa_receipts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE pa_leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
