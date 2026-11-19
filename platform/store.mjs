import {random, Fault} from './security.mjs';
const decode = r => r && ({...r, ...(r.identity ? {identity:JSON.parse(r.identity)} : {}), ...(r.metadata ? {metadata:JSON.parse(r.metadata)} : {}), ...(r.binding ? {binding:JSON.parse(r.binding)} : {}), ...(r.payload ? {payload:JSON.parse(r.payload)} : {})});
export class Store {
  constructor(db, now = Date.now) { this.db = db; this.now = now; }
  query(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async all(sql, ...args) { return (await this.query(sql, ...args).all()).results.map(decode); }
  async one(sql, ...args) { return decode(await this.query(sql, ...args).first()); }
  async run(sql, ...args) { return this.query(sql, ...args).run(); }
  async own(table, id, user) {
    if (!['connections','projects','tasks'].includes(table)) throw Error('Invalid table');
    const result = await this.one(`SELECT * FROM pa_${table} WHERE id=? AND user_id=?`, id, user);
    if (!result) throw new Fault(404, 'not_found'); return result;
  }
  async setting(user, provider) { return (await this.one('SELECT value FROM pa_settings WHERE user_id=? AND provider=?', user, provider))?.value; }
  async putSetting(user, provider, value) { await this.run('INSERT INTO pa_settings VALUES(?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET value=excluded.value', user, provider, value); }
  async connection(user, provider) { return this.one('SELECT * FROM pa_connections WHERE user_id=? AND provider=?', user, provider); }
  async connect({id, user, provider, kind, identity, credential, status='connected'}) {
    await this.run('INSERT INTO pa_connections(id,user_id,provider,kind,status,identity,credential) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET identity=excluded.identity,credential=excluded.credential,status=excluded.status,error=NULL', id, user, provider, kind, status, JSON.stringify(identity), credential ?? null);
    return this.connection(user, provider);
  }
  async putProject(user, connection, p) {
    await this.run('INSERT INTO pa_projects(id,user_id,connection_id,external_id,name,description,url,metadata,synced_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET name=excluded.name,description=excluded.description,url=excluded.url,metadata=excluded.metadata,active=1,synced_at=excluded.synced_at', p.id, user, connection, p.externalId, p.name, p.description || '', p.url, JSON.stringify(p.metadata ?? {}), this.now());
  }
  async lease(id, duration = 120000) {
    const owner = random();
    const result = await this.run('INSERT INTO pa_leases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE pa_leases.expires_at<?', id, owner, this.now()+duration, this.now());
    if (!result.meta.changes) throw new Fault(409, 'busy_retry_later');
    return async () => this.run('DELETE FROM pa_leases WHERE id=? AND owner=?', id, owner);
  }
  async putTask(task, status) {
    await this.run('INSERT INTO pa_tasks VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', task.id, task.userId, task.projectId ?? null, task.meetingKey, status, JSON.stringify(task), this.now());
    return this.own('tasks', task.id, task.userId);
  }
  async saveTask(row, status = row.status) { await this.run('UPDATE pa_tasks SET project_id=?,status=?,payload=?,updated_at=? WHERE id=? AND user_id=?', row.project_id ?? row.payload.projectId ?? null, status, JSON.stringify(row.payload), this.now(), row.id, row.user_id); }
  async receipt(id, user, payload, state) { await this.run('INSERT INTO pa_receipts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state,updated_at=excluded.updated_at', id, user, JSON.stringify(payload), state, this.now()); }
}
