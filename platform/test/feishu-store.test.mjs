import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {Execution} from '../execution.mjs';
import {route} from '../http.mjs';
import {receiveFeishu,scanInbox,storeScopes} from '../feishu-store.mjs';
import {scanSource} from '../sources.mjs';
import {seal,open,hash,b64,Fault} from '../security.mjs';
async function fixture(){
 let now=1795080000000;const calls=[];
 const env={DB:database(),PA_AUTH_MODE:'github',PA_ALLOWED_GITHUB_LOGINS:'A,B',PA_ORIGIN:'https://example.test',PA_FEISHU_STORE_CLIENT_ID:'cli_store',PA_FEISHU_STORE_CLIENT_SECRET:'store-secret',PA_FEISHU_STORE_ENCRYPT_KEY:'encrypt-key',PA_FEISHU_STORE_VERIFICATION_TOKEN:'verification-token',PA_ENCRYPTION_KEY:Buffer.alloc(32,4).toString('base64')};
 const providers={identity:async()=>({id:'ou_A',name:'A',tenantId:'tenant_A'}),feishu:async(token,path,body)=>{calls.push({token,path,body});return {};},minuteInfo:async(_,id)=>({title:'Test meeting',url:'https://example.feishu.cn/minutes/'+id}),transcript:async()=>'Implement search.'};
 const p=new Platform(env,{providers,now:()=>now,fetcher:async()=>Response.json({access_token:'oauth-access',refresh_token:'oauth-refresh',expires_in:3600})});
 p.extract=async transcript=>[{title:'Search',goal:'Search',acceptance:['Search works'],evidence:transcript}];
 const sources={};for(const who of ['A','B']){
  await p.register('user-'+who,who);const id='feishu-'+await hash('user-'+who);
  sources[who]=await p.store.connect({id,user:'user-'+who,provider:'feishu',kind:'meeting',identity:{id:'ou_'+who,name:who,tenantId:'tenant_'+who,appId:env.PA_FEISHU_STORE_CLIENT_ID,appType:'store',discovery:'events'},credential:await seal(env.PA_ENCRYPTION_KEY,{access_token:'user-'+who},id)});
  await p.store.connect({id:'agent-'+who,user:'user-'+who,provider:'bigmodel',kind:'agent',identity:{id:'bigmodel'},credential:await seal(env.PA_ENCRYPTION_KEY,{apiKey:'key-'+who},'agent-'+who)});
  await p.store.run('INSERT INTO pa_sources(connection_id,user_id,enrolled_at) VALUES(?,?,?)',id,'user-'+who,now);
 }
 async function request(type,data={},options={}){
  const payload=options.payload??{schema:'2.0',header:{app_id:env.PA_FEISHU_STORE_CLIENT_ID,event_id:options.id??'event-one',event_type:type,tenant_key:options.tenant??'tenant_A',token:env.PA_FEISHU_STORE_VERIFICATION_TOKEN,create_time:String((options.time??now)*1000)},event:data};
  const iv=new Uint8Array(16).fill(7),derived=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.PA_FEISHU_STORE_ENCRYPT_KEY)),key=await crypto.subtle.importKey('raw',derived,'AES-CBC',false,['encrypt']);
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv},key,new TextEncoder().encode(JSON.stringify(payload)))),joined=new Uint8Array(16+encrypted.length);joined.set(iv);joined.set(encrypted,16);
  const raw=JSON.stringify({encrypt:b64(joined)})+'\n',timestamp=String(Math.floor((options.requestTime??now)/1000)),nonce='nonce';
  const headers={'content-type':'application/json','x-lark-request-timestamp':timestamp,'x-lark-request-nonce':nonce,'x-lark-signature':await hash(timestamp+nonce+env.PA_FEISHU_STORE_ENCRYPT_KEY+raw),...(options.headers??{})};
  return new Request(env.PA_ORIGIN+'/api/webhooks/feishu',{method:'POST',headers,body:raw});
 }
 return {p,env,providers,sources,calls,request,now:()=>now,advance:ms=>now+=ms,close:()=>env.DB.raw.close()};
}

test('encrypted URL verification validates the configured token without a browser login',async()=>{
 const f=await fixture(),payload={type:'url_verification',token:f.env.PA_FEISHU_STORE_VERIFICATION_TOKEN,challenge:'challenge'};
 const request=await f.request('',{},{payload});assert.deepEqual(await receiveFeishu(request,f.p),{challenge:'challenge'});
 const response=await route(await f.request('',{},{payload}),f.env,'',{now:f.p.now});assert.equal(response.status,200);assert.deepEqual(await response.json(),{challenge:'challenge'});
 payload.token='wrong';const invalid=await f.request('',{},{payload});await assert.rejects(()=>receiveFeishu(invalid,f.p),{code:'feishu_event_token_invalid'});
 f.close();
});

test('webhooks reject stale signatures, modified bodies, missing encryption and wrong app IDs',async()=>{
 const f=await fixture();
 const stale=await f.request('app_open',{},{requestTime:f.now()-600000});await assert.rejects(()=>receiveFeishu(stale,f.p),{code:'feishu_event_signature_invalid'});
 const good=await f.request('app_open');const tampered=new Request(good.url,{method:'POST',headers:good.headers,body:(await good.text())+' '});await assert.rejects(()=>receiveFeishu(tampered,f.p),{code:'feishu_event_signature_invalid'});
 const payload={schema:'2.0',header:{app_id:'other-app',event_id:'other',event_type:'app_open',token:f.env.PA_FEISHU_STORE_VERIFICATION_TOKEN,create_time:String(f.now()*1000)},event:{}};
 const wrongApp=await f.request('app_open',{},{payload});await assert.rejects(()=>receiveFeishu(wrongApp,f.p),{code:'feishu_event_app_mismatch'});f.close();
});

test('unsigned events and signed plaintext events are rejected',async()=>{
 const f=await fixture(),encrypted=await f.request('app_open');encrypted.headers.delete('x-lark-signature');
 await assert.rejects(()=>receiveFeishu(encrypted,f.p),{code:'feishu_event_encryption_required'});
 const raw=JSON.stringify({schema:'2.0',header:{token:f.env.PA_FEISHU_STORE_VERIFICATION_TOKEN}}),timestamp=String(f.now()/1000),nonce='nonce';
 const plain=new Request(f.env.PA_ORIGIN+'/api/webhooks/feishu',{method:'POST',body:raw,headers:{'x-lark-request-timestamp':timestamp,'x-lark-request-nonce':nonce,'x-lark-signature':await hash(timestamp+nonce+f.env.PA_FEISHU_STORE_ENCRYPT_KEY+raw)}});
 await assert.rejects(()=>receiveFeishu(plain,f.p),{code:'feishu_event_encryption_required'});f.close();
});

test('legacy lifecycle event envelopes disable dispatch and authenticated runner publication',async()=>{
 const f=await fixture(),secret='runner-secret';
 await f.p.store.connect({id:'gh-A',user:'user-A',provider:'github',kind:'project',identity:{id:'gh-A'},credential:await seal(f.env.PA_ENCRYPTION_KEY,{access_token:'gh-token'},'gh-A')});
 await f.p.store.run('INSERT INTO pa_projects(id,user_id,connection_id,external_id,name,description,url,metadata,binding,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?)','project-A','user-A','gh-A','project-A','Project A','','https://example.test','{}',JSON.stringify({githubConnectionId:'gh-A',runnerReady:true,runnerTokenHash:await hash(secret)}),f.now());
 const ex=new Execution(f.p,'');assert.equal((await ex.runnerProject('project-A',secret)).id,'project-A');
 const payload={ts:String(f.now()/1000),uuid:'v1-stop',token:f.env.PA_FEISHU_STORE_VERIFICATION_TOKEN,type:'event_callback',event:{type:'app_status_change',app_id:f.env.PA_FEISHU_STORE_CLIENT_ID,tenant_key:'tenant_A',status:'stop'}};
 await receiveFeishu(await f.request('',{},{payload}),f.p);
 await assert.rejects(()=>ex.runnerProject('project-A',secret),{code:'runner_unauthorized'});
 await assert.rejects(()=>ex.advance({project_id:'project-A',user_id:'user-A',payload:{}}),{code:'meeting_connector_not_active'});f.close();
});

test('minute events route only to matching app, tenant and subscribed user, with durable replay receipts',async()=>{
 const f=await fixture(),data={minute_token:'MeetingToken00001',subscriber_ids:[{open_id:'ou_A'},{open_id:'ou_B'}]};
 const first=await receiveFeishu(await f.request('minutes.minute.generated_v1',data),f.p);assert.deepEqual(first.users,['user-A']);
 await receiveFeishu(await f.request('minutes.minute.generated_v1',data),f.p);
 assert.equal((await f.p.store.all('SELECT * FROM pa_feishu_inbox')).length,1);
 await receiveFeishu(await f.request('minutes.minute.generated_v1',data,{id:'event-other-tenant',tenant:'unrelated'}),f.p);
 assert.equal((await f.p.store.all('SELECT * FROM pa_feishu_inbox')).length,1);f.close();
});

test('app tickets stay encrypted and delayed old events cannot replace the current ticket',async()=>{
 const f=await fixture();await receiveFeishu(await f.request('app_ticket',{app_ticket:'new-secret-ticket'},{time:f.now(),id:'new'}),f.p);
 await receiveFeishu(await f.request('app_ticket',{app_ticket:'old-secret-ticket'},{time:f.now()-1000,id:'old'}),f.p);
 const saved=await f.p.store.one('SELECT * FROM pa_feishu_tickets');assert.equal(saved.credential.includes('secret-ticket'),false);assert.equal((await open(f.env.PA_ENCRYPTION_KEY,saved.credential,'feishu-ticket:cli_store')).ticket,'new-secret-ticket');f.close();
});

test('tenant uninstall revokes only that apps tenant credentials; stale enable events do not resurrect access',async()=>{
 const f=await fixture();await receiveFeishu(await f.request('app_uninstalled',{},{id:'uninstall'}),f.p);
 await receiveFeishu(await f.request('app_open',{},{id:'old-open',time:f.now()-1000}),f.p);
 const a=await f.p.store.connection('user-A','feishu'),b=await f.p.store.connection('user-B','feishu');assert.equal(a.credential,null);assert.equal(a.status,'needs_auth');assert.equal(b.status,'connected');assert.ok(b.credential);
 assert.equal((await f.p.store.one('SELECT * FROM pa_feishu_tenants')).status,'uninstalled');await assert.rejects(()=>f.p.access(a),{code:'feishu_app_not_installed'});f.close();
});

test('store discovery drains the durable inbox without using the custom-app-only search API',async()=>{
 const f=await fixture();f.providers.meetings=()=>assert.fail('Store apps must not search historical minutes');
 await receiveFeishu(await f.request('minutes.minute.generated_v1',{minute_token:'MeetingToken00001',subscriber_ids:[{open_id:'ou_A'}]}),f.p);
 assert.equal((await scanSource(f.p,f.sources.A)).ingested,1);assert.equal((await scanSource(f.p,f.sources.A)).ingested,0);
 assert.equal((await f.p.store.all("SELECT * FROM pa_tasks WHERE user_id='user-A'")).length,1);assert.equal((await f.p.store.all("SELECT * FROM pa_tasks WHERE user_id='user-B'")).length,0);f.close();
});

test('not-ready transcripts are retried from the inbox and are never marked complete early',async()=>{
 const f=await fixture();await receiveFeishu(await f.request('minutes.minute.generated_v1',{minute_token:'MeetingToken00001',subscriber_ids:[{open_id:'ou_A'}]}),f.p);
 f.providers.transcript=async()=>{throw new Fault(409,'transcript_not_ready');};assert.equal((await scanInbox(f.p,f.sources.A)).ingested,0);assert.equal((await f.p.store.one('SELECT state FROM pa_feishu_inbox')).state,'pending');
 f.advance(60000);f.providers.transcript=async()=>'Implement search.';assert.equal((await scanInbox(f.p,f.sources.A)).ingested,1);f.close();
});

test('shared store OAuth excludes search scope and subscribes only the newly authorized user token',async()=>{
 const f=await fixture(),url=new URL(await f.p.begin('user-A','feishu',{store:true}));assert.equal(url.searchParams.get('scope'),storeScopes);assert.equal(url.searchParams.get('scope').includes('search'),false);
 const c=await f.p.callback('user-A','feishu',new URLSearchParams({state:url.searchParams.get('state'),code:'code'}));assert.equal(c.identity.appType,'store');assert.equal(c.identity.discovery,'events');assert.deepEqual(f.calls,[{token:'oauth-access',path:'/minutes/v1/minutes/subscription',body:{event_type:'minutes.minute.generated_v1'}}]);f.close();
});

test('a transient subscription failure retains the grant and retries before inbox reads',async()=>{
 const f=await fixture(),url=new URL(await f.p.begin('user-A','feishu',{store:true}));
 f.providers.feishu=async()=>{throw new Fault(502,'provider_http_503');};
 await assert.rejects(()=>f.p.callback('user-A','feishu',new URLSearchParams({state:url.searchParams.get('state'),code:'code'})),{code:'feishu_event_subscription_failed'});
 const connection=await f.p.store.connection('user-A','feishu');assert.equal(connection.status,'connected');assert.ok(connection.credential);assert.equal(connection.error,'feishu_event_subscription_failed');
 let retried=0;f.providers.feishu=async()=>{retried++;return {};};
 await scanInbox(f.p,connection);assert.equal(retried,1);
 const active=await f.p.store.connection('user-A','feishu');assert.equal(active.identity.subscription,'active');assert.equal(active.error,null);f.close();
});
