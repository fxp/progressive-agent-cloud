CREATE TABLE IF NOT EXISTS pa_users (id TEXT PRIMARY KEY, login TEXT NOT NULL, created_at INTEGER NOT NULL, disabled_at INTEGER);
CREATE TABLE IF NOT EXISTS pa_sources (connection_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, enrolled_at INTEGER NOT NULL, cursor TEXT NOT NULL DEFAULT '{}', last_run_at INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS pa_repo_claims (repo TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pa_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL, queued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS pa_jobs_user ON pa_jobs(user_id,updated_at);
INSERT OR IGNORE INTO pa_users(id,login,created_at) SELECT user_id,json_extract(identity,'$.name'),0 FROM pa_connections WHERE provider='github';
INSERT OR IGNORE INTO pa_repo_claims(repo,project_id,user_id) SELECT lower(json_extract(binding,'$.repo')),id,user_id FROM pa_projects WHERE active=1 AND binding IS NOT NULL;
