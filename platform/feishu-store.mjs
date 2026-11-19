import {Fault,hash,open,seal,unb64} from './security.mjs';

export const storeScopes='minutes:minutes.basic:read minutes:minutes.transcript:export offline_access';
export function storeConfig(env){
 return {clientId:env.PA_FEISHU_STORE_CLIENT_ID,clientSecret:env.PA_FEISHU_STORE_CLIENT_SECRET,appType:'store',scope:storeScopes,tokenVersion:'v2'};
}
export async function assertTenant(p,connection){
 if(connection.identity?.appType!=='store')return;
 const tenant=await p.store.one('SELECT status FROM pa_feishu_tenants WHERE app_id=? AND tenant_key=?',connection.identity.appId,connection.identity.tenantId);
 if(tenant&&tenant.status!=='active')throw new Fault(409,'feishu_app_not_installed');
}
export async function subscribeMinutes(p,connection,token){
 if(!connection.identity.tenantId)throw new Fault(502,'feishu_tenant_missing');
 await assertTenant(p,connection);
 await p.providers.feishu(token,'/minutes/v1/minutes/subscription',{event_type:'minutes.minute.generated_v1'});
 connection.identity={...connection.identity,subscription:'active'};
 await p.store.run('UPDATE pa_connections SET identity=?,error=NULL WHERE id=?',JSON.stringify(connection.identity),connection.id);
}
const validID=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
const jsonValue=text=>{try{return JSON.parse(text);}catch{throw new Fault(400,'feishu_event_invalid');}};
export async function receiveFeishu(request,p){
 if(request.method!=='POST')throw new Fault(405,'method_not_allowed');
 const env=p.env,appId=env.PA_FEISHU_STORE_CLIENT_ID,key=env.PA_FEISHU_STORE_ENCRYPT_KEY,verification=env.PA_FEISHU_STORE_VERIFICATION_TOKEN;
 if(!appId||!key||!verification)throw new Fault(503,'feishu_webhook_not_configured');
 if(Number(request.headers.get('content-length')??0)>262144)throw new Fault(413,'request_too_large');
 const raw=await request.text();if(raw.length>262144)throw new Fault(413,'request_too_large');
 const envelope=jsonValue(raw),signature=request.headers.get('x-lark-signature');
 if(signature){
  const timestamp=request.headers.get('x-lark-request-timestamp'),nonce=request.headers.get('x-lark-request-nonce');
  if(!/^\d{10}$/.test(timestamp??'')||!nonce||nonce.length>256||Math.abs(Number(timestamp)*1000-p.now())>300000||await hash(timestamp+nonce+key+raw)!==signature)throw new Fault(401,'feishu_event_signature_invalid');
 }
 let event=envelope;
 if(typeof envelope.encrypt==='string'){
  try{const bytes=unb64(envelope.encrypt);if(bytes.length<32||bytes.length%16)throw Error();const derived=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)),aes=await crypto.subtle.importKey('raw',derived,'AES-CBC',false,['decrypt']);event=jsonValue(new TextDecoder('utf-8',{fatal:true}).decode(await crypto.subtle.decrypt({name:'AES-CBC',iv:bytes.slice(0,16)},aes,bytes.slice(16))));}catch{throw new Fault(401,'feishu_event_decryption_failed');}
 }
 const supplied=event.schema?event.header?.token:event.token;
 if(typeof supplied!=='string'||!supplied||await hash(supplied)!==await hash(verification))throw new Fault(401,'feishu_event_token_invalid');
 if(event.type==='url_verification'){
  if(typeof event.challenge!=='string'||event.challenge.length>2048)throw new Fault(400,'feishu_event_invalid');
  return {challenge:event.challenge};
 }
 if(!signature||typeof envelope.encrypt!=='string')throw new Fault(401,'feishu_event_encryption_required');
 const header=event.header??{},data=event.event??{},application=header.app_id??data.app_id;
 if(application!==appId||(data.app_id&&data.app_id!==appId))throw new Fault(401,'feishu_event_app_mismatch');
 const type=header.event_type??data.type,identifier=header.event_id??event.uuid;
 if(!validID(identifier))throw new Fault(400,'feishu_event_id_required');
 const id=await hash(appId+':'+identifier),s=p.store;
 const release=await s.lease('feishu-event:'+id,15000);
 try{
  if(await s.one('SELECT id FROM pa_feishu_events WHERE id=?',id))return {users:[],duplicate:true};
  let time=Number(header.create_time??event.ts);if(time<1e11)time*=1000;else if(time>1e14)time=Math.floor(time/1000);
  if(!Number.isFinite(time)||time<=0||time>p.now()+300000)throw new Fault(400,'feishu_event_time_invalid');
  const statements=[],users=new Set(),tenant=header.tenant_key??data.tenant_key;
  if(type==='app_ticket'){
   if(typeof data.app_ticket!=='string'||!data.app_ticket||data.app_ticket.length>4096)throw new Fault(400,'feishu_ticket_invalid');
   statements.push(s.query('INSERT INTO pa_feishu_tickets VALUES(?,?,?) ON CONFLICT(app_id) DO UPDATE SET credential=excluded.credential,updated_at=excluded.updated_at WHERE excluded.updated_at>=pa_feishu_tickets.updated_at',appId,await seal(env.PA_ENCRYPTION_KEY,{ticket:data.app_ticket},'feishu-ticket:'+appId),time));
  }else if(['app_open','app_status_change','app_uninstalled'].includes(type)){
   if(!validID(tenant))throw new Fault(400,'feishu_tenant_missing');
   const status=type==='app_uninstalled'?'uninstalled':type==='app_open'||data.status==='start'?'active':data.status==='stop'?'paused':null;
   if(status){
    statements.push(s.query('INSERT INTO pa_feishu_tenants VALUES(?,?,?,?) ON CONFLICT(app_id,tenant_key) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at WHERE excluded.updated_at>=pa_feishu_tenants.updated_at',appId,tenant,status,time));
    if(status!=='active')statements.push(s.query("UPDATE pa_connections SET status='needs_auth',error='feishu_app_not_installed',credential=CASE WHEN ?='uninstalled' THEN NULL ELSE credential END WHERE provider='feishu' AND json_extract(identity,'$.appId')=? AND json_extract(identity,'$.tenantId')=? AND EXISTS(SELECT 1 FROM pa_feishu_tenants WHERE app_id=? AND tenant_key=? AND status=? AND updated_at=?)",status,appId,tenant,appId,tenant,status,time));
   }
  }else if(type==='minutes.minute.generated_v1'){
   if(!validID(tenant)||!/^[A-Za-z0-9]{12,64}$/.test(data.minute_token??''))throw new Fault(400,'feishu_minute_invalid');
   if(!Array.isArray(data.subscriber_ids)||data.subscriber_ids.length>500)throw new Fault(400,'feishu_subscribers_invalid');
   const subscriberIds=new Set(data.subscriber_ids.map(s=>s.open_id).filter(validID));
   const connections=await s.all("SELECT c.* FROM pa_connections c JOIN pa_users u ON u.id=c.user_id WHERE c.provider='feishu' AND c.status='connected' AND u.disabled_at IS NULL AND json_extract(c.identity,'$.appId')=? AND json_extract(c.identity,'$.tenantId')=?",appId,tenant);
   const state=await s.one('SELECT status FROM pa_feishu_tenants WHERE app_id=? AND tenant_key=?',appId,tenant);
   if(!state||state.status==='active')for(const c of connections.filter(c=>subscriberIds.has(c.identity.id))){
    statements.push(s.query('INSERT OR IGNORE INTO pa_feishu_inbox(connection_id,user_id,minute_token,received_at) VALUES(?,?,?,?)',c.id,c.user_id,data.minute_token,time));users.add(c.user_id);
   }
  }
  statements.push(s.query('INSERT INTO pa_feishu_events VALUES(?,?,?)',id,appId,p.now()));
  await p.env.DB.batch(statements);return {users:[...users]};
 }finally{await release();}
}
export async function scanInbox(p,connection){
 await assertTenant(p,connection);
 const token=await p.access(connection),s=p.store;
 if(connection.identity.subscription!=='active')await subscribeMinutes(p,connection,token);
 const rows=await s.all("SELECT * FROM pa_feishu_inbox WHERE connection_id=? AND user_id=? AND state='pending' AND retry_at<=? ORDER BY received_at LIMIT 5",connection.id,connection.user_id,p.now());
 for(const row of rows){
  try{
   const info=await p.providers.minuteInfo(token,row.minute_token),transcript=await p.providers.transcript(token,row.minute_token);
   if(!transcript)throw new Fault(409,'transcript_not_ready');
   await p.ingest(connection,{...info,externalId:row.minute_token,transcript});
   await s.run("UPDATE pa_feishu_inbox SET state='completed',error=NULL,title=?,url=? WHERE connection_id=? AND minute_token=?",info.title,info.url,connection.id,row.minute_token);
   await s.run('UPDATE pa_sources SET last_run_at=?,error=NULL WHERE connection_id=?',p.now(),connection.id);
   return {ingested:1,discovered:rows.length};
  }catch(error){
   await s.run('UPDATE pa_feishu_inbox SET error=?,retry_at=? WHERE connection_id=? AND minute_token=?',error.code??'meeting_read_failed',p.now()+60000,connection.id,row.minute_token);
   if(error.code!=='transcript_not_ready'&&!/^feishu_api_209100[2-5]$/.test(error.code??''))throw error;
  }
 }
 await s.run('UPDATE pa_sources SET last_run_at=?,error=NULL WHERE connection_id=?',p.now(),connection.id);
 return {ingested:0,discovered:rows.length};
}
