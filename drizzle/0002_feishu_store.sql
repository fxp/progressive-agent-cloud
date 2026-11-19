CREATE TABLE IF NOT EXISTS pa_feishu_tickets (app_id TEXT PRIMARY KEY, credential TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pa_feishu_tenants (app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(app_id,tenant_key));
CREATE TABLE IF NOT EXISTS pa_feishu_events (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, received_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pa_feishu_inbox (connection_id TEXT NOT NULL, user_id TEXT NOT NULL, minute_token TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, title TEXT, url TEXT, PRIMARY KEY(connection_id,minute_token));
CREATE INDEX IF NOT EXISTS pa_feishu_inbox_user ON pa_feishu_inbox(user_id,state,retry_at,received_at);
