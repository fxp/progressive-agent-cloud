import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {startBootstrap,pollBootstrap,bootstrapOAuth,bootstrapUserScopes,todoUserScopes} from '../feishu-bootstrap.mjs';
import {seal,open} from '../security.mjs';
import {route} from '../http.mjs';
import {sessionCookie} from '../auth.mjs';

async function fixture(){
 let now=1795080000000,pending=true,patchFails=false,identity='ou_new',scope=todoUserScopes.join(' ');const calls=[];
 const env={DB:database(),PA_ORIGIN:'https://example.test',PA_AUTH_MODE:'github',PA_SIGNUP_MODE:'open',PA_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64'),PA_SESSION_KEY:Buffer.alloc(32,3).toString('base64')};
 const fetcher=async(url,options)=>{
  const body=options.body instanceof URLSearchParams?Object.fromEntries(options.body):JSON.parse(options.body);calls.push({url,body,method:options.method});
  if(body.action==='begin')return Response.json({device_code:'private-device-code',verification_uri_complete:'https://open.feishu.cn/page/launcher?user_code=public-code',expires_in:600,interval:5});
  if(body.action==='poll')return pending?Response.json({error:'authorization_pending'},{status:400}):Response.json({client_id:'cli_new',client_secret:'private-app-secret',user_info:{open_id:'ou_new',tenant_brand:'feishu'}});
  if(url.endsWith('/device_authorization'))return Response.json({device_code:'private-user-device-code',verification_uri_complete:'https://accounts.feishu.cn/device?user_code=user-code',expires_in:240,interval:5});
  if(body.grant_type==='urn:ietf:params:oauth:grant-type:device_code')return Response.json({access_token:'new-access',refresh_token:patchFails?undefined:'new-refresh',expires_in:3600,scope});
  if(url.endsWith('/oauth/token')||url.endsWith('/oauth/v3/token'))return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
  throw Error('Unexpected endpoint');
 };
 const p=new Platform(env,{fetcher,now:()=>now,providers:{identity:async()=>({id:identity,name:'User',tenantId:'tenant_new'})}});
 await p.register('A','A');await p.register('B','B');
 return {p,env,calls,advance:ms=>now+=ms,confirm:()=>pending=false,patchFailure:value=>patchFails=value,identity:value=>identity=value,scope:value=>scope=value,close:()=>env.DB.raw.close()};
}
test('registration is owned, encrypted, reusable and requests only declared configuration',async()=>{
 const f=await fixture(),first=await startBootstrap(f.p,'A'),second=await startBootstrap(f.p,'A');
 assert.equal(first.id,second.id);assert.equal(f.calls.length,1);
 const url=new URL(first.verificationUrl),addons=JSON.parse(gunzipSync(Buffer.from(url.searchParams.get('addons'),'base64url')));
 assert.equal(url.searchParams.get('createOnly'),'true');assert.equal(addons.preset,false);assert.equal(addons.scopes.tenant,undefined);assert.deepEqual(addons.scopes.user,todoUserScopes);
 const raw=(await f.p.store.one('SELECT credential FROM pa_feishu_setups')).credential;assert.equal(raw.includes('private-device-code'),false);assert.equal(JSON.stringify(first).includes('private-device-code'),false);
 await assert.rejects(()=>pollBootstrap(f.p,'B',first.id),{code:'not_found'});f.close();
});
test('server poll timing prevents browser retries from hammering Feishu',async()=>{
 const f=await fixture(),setup=await startBootstrap(f.p,'A');await pollBootstrap(f.p,'A',setup.id);assert.equal(f.calls.length,1);
 f.advance(5000);const pending=await pollBootstrap(f.p,'A',setup.id);assert.equal(pending.state,'pending');assert.equal(pending.verificationUrl,setup.verificationUrl);await pollBootstrap(f.p,'A',setup.id);assert.equal(f.calls.filter(c=>c.body.action==='poll').length,1);f.close();
});
test('one-time app credentials are reused for device authorization without management APIs',async()=>{
 const f=await fixture(),setup=await startBootstrap(f.p,'A');f.advance(5000);f.confirm();
 assert.equal((await pollBootstrap(f.p,'A',setup.id)).state,'ready');
 const first=await bootstrapOAuth(f.p,'A',setup.id),second=await bootstrapOAuth(f.p,'A',setup.id);
 assert.equal(first.verificationUrl,second.verificationUrl);assert.equal(first.state,'user_authorizing');assert.equal(first.readingMode,'todos');
 assert.equal(f.calls.filter(c=>c.body.action==='begin').length,1);assert.equal(f.calls.filter(c=>c.body.action==='poll').length,1);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/device_authorization')).length,1);
 assert.equal(f.calls.some(c=>c.url.includes('/config')||c.url.includes('tenant_access_token')),false);
 assert.equal(JSON.stringify(first).includes('private-'),false);f.close();
});
test('expiry wipes device credentials and does not touch an existing connection',async()=>{
 const f=await fixture(),setup=await startBootstrap(f.p,'A');f.advance(601000);assert.equal((await pollBootstrap(f.p,'A',setup.id)).state,'expired');
 assert.equal((await f.p.store.one('SELECT credential FROM pa_feishu_setups')).credential,null);f.close();
});
test('new data authorization replaces the old grant only after verifying the registering account',async()=>{
 const f=await fixture(),old=await f.p.store.connect({id:'old-source',user:'A',provider:'feishu',kind:'meeting',identity:{id:'ou_old',appId:'cli_old'},credential:await seal(f.env.PA_ENCRYPTION_KEY,{access_token:'old-access'},'old-source')});
 const setup=await startBootstrap(f.p,'A');f.confirm();f.advance(5000);await pollBootstrap(f.p,'A',setup.id);
 assert.equal((await f.p.store.connection('A','feishu')).identity.id,'ou_old');assert.equal(await f.p.store.setting('A','feishu'),undefined);
 const config=(await open(f.env.PA_ENCRYPTION_KEY,(await f.p.store.one('SELECT credential FROM pa_feishu_setups')).credential,'feishu-setup:'+setup.id)).config;
 const first=new URL(await f.p.begin('A','feishu',{config,replaceConnection:true,expectedFeishuOpenId:'ou_new'}));f.identity('ou_wrong');
 await assert.rejects(()=>f.p.callback('A','feishu',new URLSearchParams({state:first.searchParams.get('state'),code:'wrong'})),{code:'feishu_bootstrap_account_mismatch'});
 assert.equal((await f.p.store.connection('A','feishu')).credential,old.credential);
 const second=new URL(await f.p.begin('A','feishu',{config,replaceConnection:true,expectedFeishuOpenId:'ou_new'}));f.identity('ou_new');
 const connection=await f.p.callback('A','feishu',new URLSearchParams({state:second.searchParams.get('state'),code:'right'}));
 assert.equal(connection.identity.id,'ou_new');assert.equal(connection.identity.appId,'cli_new');assert.equal(connection.identity.discovery,'search');
 // The row ID is stable even when a legacy ID predates the deterministic hash.
 assert.equal((await open(f.env.PA_ENCRYPTION_KEY,connection.credential,connection.id)).access_token,'new-access');
 assert.equal((await f.p.config('A','feishu')).clientId,'cli_new');assert.equal((await f.p.store.one('SELECT state FROM pa_feishu_setups')).state,'completed');f.close();
});
test('HTTP bootstrap requires a signed account session and matching POST origin',async()=>{
 const f=await fixture(),url=f.env.PA_ORIGIN+'/api/connectors/feishu/bootstrap/start';
 assert.equal((await route(new Request(url,{method:'POST'}),f.env,'')).status,401);
 const cookie=(await sessionCookie({user:'A',login:'A'},{secret:f.env.PA_SESSION_KEY})).split(';')[0];
 assert.equal((await route(new Request(url,{method:'POST',headers:{cookie,origin:'https://other.test'}}),f.env,'')).status,403);f.close();
});

test('device authorization connects the verified owner with a renewable cloud grant',async()=>{
 const f=await fixture(),setup=await startBootstrap(f.p,'A');f.confirm();f.advance(5000);await pollBootstrap(f.p,'A',setup.id);
 await bootstrapOAuth(f.p,'A',setup.id);f.advance(5000);const result=await pollBootstrap(f.p,'A',setup.id);assert.equal(result.state,'completed');
 const connection=await f.p.store.connection('A','feishu');assert.equal(connection.identity.appId,'cli_new');assert.equal(connection.identity.id,'ou_new');
 assert.equal((await f.p.config('A','feishu')).tokenVersion,'v3');
 assert.equal(JSON.parse((await f.p.store.one('SELECT cursor FROM pa_sources')).cursor).bootstrapDone,true);
 assert.equal(JSON.stringify(result).includes('new-refresh'),false);f.close();
});
test('a short-lived device grant without refresh is not treated as an always-on connection',async()=>{
 const f=await fixture(),setup=await startBootstrap(f.p,'A');f.confirm();f.advance(5000);await pollBootstrap(f.p,'A',setup.id);
 await bootstrapOAuth(f.p,'A',setup.id);f.patchFailure(true);f.advance(5000);
 const result=await pollBootstrap(f.p,'A',setup.id);assert.equal(result.state,'blocked');assert.equal(result.error,'feishu_offline_scope_required');
 assert.equal(await f.p.store.connection('A','feishu'),null);f.close();
});

test('partially approved Minutes scopes remain pending without replacing the current grant',async()=>{
 const f=await fixture(),setup=await startBootstrap(f.p,'A');f.confirm();f.advance(5000);await pollBootstrap(f.p,'A',setup.id);
 await bootstrapOAuth(f.p,'A',setup.id);f.scope('minutes:minutes.basic:read minutes:minutes.search:read offline_access');f.advance(5000);
 const result=await pollBootstrap(f.p,'A',setup.id);assert.equal(result.state,'awaiting_approval');assert.deepEqual(result.missingScopes,['minutes:minutes.artifacts:read']);
 assert.equal(await f.p.store.connection('A','feishu'),null);const stored=await f.p.store.one('SELECT credential FROM pa_feishu_setups');
 const payload=await open(f.env.PA_ENCRYPTION_KEY,stored.credential,'feishu-setup:'+setup.id);assert.equal(payload.token,undefined);assert.equal(payload.deviceAuth,undefined);
 assert.equal((await startBootstrap(f.p,'A')).state,'awaiting_approval');f.close();
});

test('todo mode requests AI artifacts without export and activates only its own complete grant',async()=>{
 const f=await fixture(),setup=await startBootstrap(f.p,'A');f.confirm();f.advance(5000);await pollBootstrap(f.p,'A',setup.id);
 const authorization=await bootstrapOAuth(f.p,'A',setup.id,{mode:'todos'});assert.equal(authorization.readingMode,'todos');
 const requested=f.calls.find(c=>c.url.endsWith('/device_authorization')).body.scope;assert.equal(requested.includes('transcript:export'),false);assert.equal(requested.includes('minutes.artifacts:read'),true);
 f.scope(todoUserScopes.join(' '));f.advance(5000);assert.equal((await pollBootstrap(f.p,'A',setup.id)).state,'completed');
 assert.equal((await f.p.store.connection('A','feishu')).identity.meetingContent,'todos');assert.equal((await f.p.config('A','feishu')).meetingContent,'todos');f.close();
});
test('a previous transcript grant cannot satisfy AI artifacts permission in todo mode',async()=>{
 const f=await fixture(),setup=await startBootstrap(f.p,'A');f.confirm();f.advance(5000);await pollBootstrap(f.p,'A',setup.id);
 f.scope(bootstrapUserScopes.join(' '));await bootstrapOAuth(f.p,'A',setup.id,{mode:'todos'});f.advance(5000);const result=await pollBootstrap(f.p,'A',setup.id);
 assert.equal(result.state,'awaiting_approval');assert.deepEqual(result.missingScopes,['minutes:minutes.artifacts:read']);assert.equal(await f.p.store.connection('A','feishu'),null);f.close();
});
