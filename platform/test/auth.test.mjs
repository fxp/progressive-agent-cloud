import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../../scripts/local-db.mjs';
import {route} from '../http.mjs';
import {Platform} from '../service.mjs';
import {Fault,hash} from '../security.mjs';
import {sign,verify,readCookie,loginAllowed,SESSION_COOKIE,PREAUTH_COOKIE,SESSION_CONTEXT,PREAUTH_CONTEXT,SESSION_TTL_MS,PREAUTH_TTL_MS} from '../auth.mjs';

const SESSION_KEY=Buffer.alloc(32,7).toString('base64');
const CONNECTION_USER='github:9750';

function githubEnv(overrides={}){
  return {
    DB:database(),
    PA_ORIGIN:'https://example.test',
    PA_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64'),
    PA_SESSION_KEY:SESSION_KEY,
    PA_AUTH_MODE:'github',
    PA_ALLOWED_GITHUB_LOGINS:'octocat, Friend.Login',
    PA_GITHUB_CLIENT_ID:'gh-client',
    PA_GITHUB_CLIENT_SECRET:'gh-secret',
    ...overrides,
  };
}

function githubFixture({login='octocat',userId='9750',token='gho-token'}={}){
  const counters={identity:0,exchange:0,projects:0};
  const providers={
    identity:async(provider,used)=>{
      counters.identity++;
      if(provider!=='github')throw new Fault(400,'unknown_connector');
      if(used!==token)throw new Fault(401,'oauth_token_exchange_failed');
      return {id:userId,name:login};
    },
    projects:async(provider)=>{
      counters.projects++;
      if(provider!=='github')throw new Fault(400,'not_a_project_connector');
      return [];
    },
  };
  const fetcher=async url=>{
    if(url==='https://github.com/login/oauth/access_token'){counters.exchange++;return Response.json({access_token:token,token_type:'bearer'});}
    throw Error('Unexpected fetch '+url);
  };
  return {providers,fetcher,counters,options:{providers,fetcher}};
}

const get=(env,path,headers={},options={})=>route(new Request('https://example.test'+path,{headers}),env,'',options);
const post=(env,path,headers={},data)=>route(new Request('https://example.test'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data??{})}),env,'',{});
const all=(env,sql,...args)=>env.DB.prepare(sql).bind(...args).all().then(r=>r.results);

function cookieFrom(response,prefix){
  const header=response.headers.getSetCookie().find(c=>c.startsWith(prefix+'='));
  return header?{header,value:header.split(';')[0].slice(prefix.length+1)}:null;
}

function loginRequest(token,path='/api/state',headers={}){
  return get(githubEnv(),path,{cookie:`${SESSION_COOKIE}=${token}`,...headers});
}

test('signed cookies reject tampering, expiry, wrong context and wrong key without throwing',async()=>{
  const value={user:'github:1',login:'octocat'};
  const token=await sign(value,{secret:SESSION_KEY,context:SESSION_CONTEXT,ttlMs:SESSION_TTL_MS,now:1000000});
  assert.deepEqual(await verify(token,{secret:SESSION_KEY,context:SESSION_CONTEXT,now:1000001}),value);
  const [payload,signature]=token.split('.');
  // Flipped payload and signature characters, truncated tokens, garbage.
  for(const bad of [payload.slice(0,-1)+'A'+'.'+signature,payload+'.'+signature.slice(0,-1)+'A',signature,payload+'','not-a-token','','x.y.z',null,undefined,42]){
    assert.equal(await verify(bad,{secret:SESSION_KEY,context:SESSION_CONTEXT,now:1000001}),null);
  }
  // Expired is rejected, even one millisecond late.
  assert.deepEqual(await verify(token,{secret:SESSION_KEY,context:SESSION_CONTEXT,now:1000000+SESSION_TTL_MS}),null);
  assert.deepEqual(await verify(token,{secret:SESSION_KEY,context:SESSION_CONTEXT,now:1000000+SESSION_TTL_MS-1}),value);
  // A session token is not valid as a preauth token (context binding).
  assert.equal(await verify(token,{secret:SESSION_KEY,context:PREAUTH_CONTEXT,now:1000001}),null);
  // A different key cannot open the token.
  assert.equal(await verify(token,{secret:Buffer.alloc(32,9).toString('base64'),context:SESSION_CONTEXT,now:1000001}),null);
  // Missing or malformed PA_SESSION_KEY fails closed.
  assert.equal(await verify(token,{secret:'',context:SESSION_CONTEXT,now:1000001}),null);
  assert.equal(await verify(token,{secret:'short-key',context:SESSION_CONTEXT,now:1000001}),null);
  assert.equal(await verify(token,{secret:'!!!not-base64!!!',context:SESSION_CONTEXT,now:1000001}),null);
  const preauth=await sign({user:'pending'},{secret:SESSION_KEY,context:PREAUTH_CONTEXT,ttlMs:PREAUTH_TTL_MS,now:1000000});
  assert.deepEqual(await verify(preauth,{secret:SESSION_KEY,context:PREAUTH_CONTEXT,now:1000000+PREAUTH_TTL_MS-1}),{user:'pending'});
  assert.equal(await verify(preauth,{secret:SESSION_KEY,context:PREAUTH_CONTEXT,now:1000000+PREAUTH_TTL_MS}),null);
});

test('GitHub login allowlist is case-insensitive and denies by default',()=>{
  const env=githubEnv();
  assert.equal(loginAllowed(env,'octocat'),true);
  assert.equal(loginAllowed(env,'  OCTOCAT '),true);
  assert.equal(loginAllowed(env,'friend.login'),true);
  assert.equal(loginAllowed(env,'friend.LOGIN'),true);
  assert.equal(loginAllowed(env,'stranger'),false);
  assert.equal(loginAllowed(env,''),false);
  assert.equal(loginAllowed(env,null),false);
  assert.equal(loginAllowed(githubEnv({PA_ALLOWED_GITHUB_LOGINS:''}),'octocat'),false);
  assert.equal(loginAllowed(githubEnv({PA_ALLOWED_GITHUB_LOGINS:undefined}),'octocat'),false);
  assert.equal(loginAllowed(githubEnv({PA_ALLOWED_GITHUB_LOGINS:' , '}),'octocat'),false);
});

test('GitHub mode never trusts oai-authenticated-user-id headers',async()=>{
  const env=githubEnv();const f=githubFixture();
  const impersonate={'oai-authenticated-user-id':CONNECTION_USER};
  const state=await get(env,'/api/state',impersonate,f.options);
  assert.equal(state.status,401);
  const payload=await state.json();
  assert.equal(payload.error,'sign_in_required');
  assert.equal(payload.loginUrl,'/api/oauth/github/start');
  assert.equal((await post(env,'/api/connectors/github/settings',{...impersonate,origin:'https://example.test'},{clientId:'x'})).status,401);
  assert.equal((await get(env,'/api/oauth/linear/start',impersonate,f.options)).status,401);
  // A header with a fabricated session user gains nothing on callback: no
  // signed preauth cookie means no login, regardless of headers.
  const callback=await get(env,'/api/oauth/github/callback?state=伪造&code=x',{...impersonate,'oai-authenticated-user-id':'github:1'},f.options);
  assert.equal(callback.status,302);
  assert.match(callback.headers.get('location'),/error=preauth_required/);
  env.DB.raw.close();
});

test('first login: PKCE start issues signed preauth cookie and callback mints a session',async()=>{
  const env=githubEnv();const f=githubFixture();
  const start=await get(env,'/api/oauth/github/start',{},f.options);
  assert.equal(start.status,302);
  const target=new URL(start.headers.get('location'));
  assert.equal(target.origin+target.pathname,'https://github.com/login/oauth/authorize');
  assert.equal(target.searchParams.get('client_id'),'gh-client');
  assert.equal(target.searchParams.get('response_type'),'code');
  assert.equal(target.searchParams.get('code_challenge_method'),'S256');
  assert.ok(target.searchParams.get('code_challenge'));
  const state=target.searchParams.get('state');
  const preauth=cookieFrom(start,PREAUTH_COOKIE);
  assert.ok(preauth);
  assert.match(preauth.header,/Path=\/; SameSite=Lax; HttpOnly/);
  assert.match(preauth.header,/Max-Age=600/);
  assert.match(preauth.header,/Secure/);
  const pending=await verify(preauth.value,{secret:SESSION_KEY,context:PREAUTH_CONTEXT,now:Date.now()});
  assert.ok(pending?.user);
  // The pending state row is user-bound and expiring.
  const [row]=(await all(env,'SELECT * FROM pa_oauth WHERE user_id=?',pending.user));
  assert.equal(row.user_id,pending.user);
  assert.equal(row.provider,'github');
  assert.ok(row.expires_at>Date.now());

  const done=await get(env,`/api/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`,{cookie:`${PREAUTH_COOKIE}=${preauth.value}`},f.options);
  assert.equal(done.status,302);
  assert.equal(new URL(done.headers.get('location')).origin+new URL(done.headers.get('location')).pathname,'https://example.test/app');
  const session=cookieFrom(done,SESSION_COOKIE);
  assert.ok(session);
  assert.match(session.header,/HttpOnly/);
  assert.match(session.header,/Max-Age=604800/);
  const restored=await verify(session.value,{secret:SESSION_KEY,context:SESSION_CONTEXT,now:Date.now()});
  assert.deepEqual(restored,{user:CONNECTION_USER,login:'octocat'});
  // Preauth cookie is cleared after use.
  assert.match(cookieFrom(done,PREAUTH_COOKIE).header,/Max-Age=0/);
  // Stable internal user id derives from the GitHub numeric id, connection is encrypted.
  const [connection]=(await all(env,'SELECT * FROM pa_connections WHERE provider=?','github'));
  assert.equal(connection.user_id,CONNECTION_USER);
  assert.equal(JSON.parse(connection.identity).id,'9750');
  assert.ok(!connection.credential.includes('gho-token'));
  assert.equal(f.counters.exchange,1);
  assert.equal(f.counters.identity,1);

  // The session cookie authenticates state; the header is irrelevant.
  const stateResponse=await get(env,'/api/state',{cookie:`${SESSION_COOKIE}=${session.value}`,'oai-authenticated-user-id':'nobody-else'},f.options);
  assert.equal(stateResponse.status,200);
  const body=await stateResponse.json();
  assert.equal(body.connectors.find(c=>c.id==='github').status,'connected');
  // Someone else's session user id cannot read this user's state.
  await new Platform(env).register('github:1111','Friend.Login');
  const other=await sign({user:'github:1111',login:'Friend.Login'},{secret:SESSION_KEY,context:SESSION_CONTEXT,ttlMs:SESSION_TTL_MS});
  const foreign=await get(env,'/api/state',{cookie:`${SESSION_COOKIE}=${other}`,'oai-authenticated-user-id':CONNECTION_USER},f.options);
  assert.equal(foreign.status,200);
  assert.equal((await foreign.json()).connectors.find(c=>c.id==='github').status,'disconnected');
  env.DB.raw.close();
});

test('login outside the allowlist is denied before any connection is saved',async()=>{
  const env=githubEnv({PA_ALLOWED_GITHUB_LOGINS:'someoneelse'});
  const f=githubFixture({login:'octocat'});
  const start=await get(env,'/api/oauth/github/start',{},f.options);
  const preauth=cookieFrom(start,PREAUTH_COOKIE);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const done=await get(env,`/api/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`,{cookie:`${PREAUTH_COOKIE}=${preauth.value}`},f.options);
  assert.equal(done.status,302);
  assert.match(done.headers.get('location'),/error=github_login_not_allowed/);
  assert.equal(cookieFrom(done,SESSION_COOKIE),null);
  assert.equal((await all(env,'SELECT COUNT(*) AS n FROM pa_connections'))[0].n,0);
  // A login that changes case later still matches the allowlist.
  const caseEnv=githubEnv({PA_ALLOWED_GITHUB_LOGINS:'OCTOCAT'});
  const caseFixture=githubFixture({login:'octoCat'});
  const caseStart=await get(caseEnv,'/api/oauth/github/start',{},caseFixture.options);
  const casePreauth=cookieFrom(caseStart,PREAUTH_COOKIE);
  const caseState=new URL(caseStart.headers.get('location')).searchParams.get('state');
  const caseDone=await get(caseEnv,`/api/oauth/github/callback?state=${encodeURIComponent(caseState)}&code=auth-code`,{cookie:`${PREAUTH_COOKIE}=${casePreauth.value}`},caseFixture.options);
  assert.equal(caseDone.status,302);
  assert.match(caseDone.headers.get('location'),/connected=github/);
  env.DB.raw.close();
});

test('verified login survives project API failure so the connector can be retried',async()=>{
  const env=githubEnv(),f=githubFixture();
  f.providers.projects=async()=>{throw new Fault(502,'provider_graphql_error');};
  const start=await get(env,'/api/oauth/github/start',{},f.options);
  const preauth=cookieFrom(start,PREAUTH_COOKIE);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const done=await get(env,`/api/oauth/github/callback?state=${state}&code=code`,{cookie:`${PREAUTH_COOKIE}=${preauth.value}`},f.options);
  assert.match(done.headers.get('location'),/error=project_sync_failed/);
  const session=cookieFrom(done,SESSION_COOKIE);assert.ok(session);
  const result=await get(env,'/api/state',{cookie:`${SESSION_COOKIE}=${session.value}`},f.options);
  assert.equal(result.status,200);
  const github=(await result.json()).connectors.find(c=>c.id==='github');
  assert.equal(github.status,'error');assert.equal(github.error,'provider_graphql_error');
  env.DB.raw.close();
});

test('removing a login from the allowlist rejects an existing session',async()=>{
  const env=githubEnv({PA_ALLOWED_GITHUB_LOGINS:'somebodyelse'});
  const token=await sign({user:CONNECTION_USER,login:'octocat'},{secret:SESSION_KEY,context:SESSION_CONTEXT,ttlMs:SESSION_TTL_MS});
  const response=await get(env,'/api/state',{cookie:`${SESSION_COOKIE}=${token}`});
  assert.equal(response.status,403);assert.equal((await response.json()).error,'github_login_not_allowed');
  env.DB.raw.close();
});

test('callback requires a valid preauth cookie: missing, expired and cross-use fail closed',async()=>{
  const env=githubEnv();const f=githubFixture();
  const start=await get(env,'/api/oauth/github/start',{},f.options);
  const preauth=cookieFrom(start,PREAUTH_COOKIE);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  // No cookie at all.
  const missing=await get(env,`/api/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`,{},f.options);
  assert.equal(missing.status,302);
  assert.match(missing.headers.get('location'),/error=preauth_required/);
  // Tampered cookie.
  const tampered=await get(env,`/api/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`,{cookie:`${PREAUTH_COOKIE}=${preauth.value.slice(0,-2)}AA`},f.options);
  assert.match(tampered.headers.get('location'),/error=preauth_required/);
  // A session token cannot stand in for the preauth cookie (context binding):
  // even under the preauth cookie name it fails verification.
  const session=await sign({user:CONNECTION_USER,login:'octocat'},{secret:SESSION_KEY,context:SESSION_CONTEXT,ttlMs:SESSION_TTL_MS});
  const crossUse=await get(env,`/api/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`,{cookie:`${PREAUTH_COOKIE}=${session}`},f.options);
  assert.match(crossUse.headers.get('location'),/error=preauth_required/);
  // Expired preauth cookie.
  const expired=await sign({user:'pending'},{secret:SESSION_KEY,context:PREAUTH_CONTEXT,ttlMs:PREAUTH_TTL_MS,now:Date.now()-PREAUTH_TTL_MS-1000});
  const stale=await get(env,`/api/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`,{cookie:`${PREAUTH_COOKIE}=${expired}`},f.options);
  assert.match(stale.headers.get('location'),/error=preauth_required/);
  // A valid preauth for a different pending user cannot consume this state.
  const otherPending=await sign({user:'other-pending'},{secret:SESSION_KEY,context:PREAUTH_CONTEXT,ttlMs:PREAUTH_TTL_MS});
  const mismatch=await get(env,`/api/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`,{cookie:`${PREAUTH_COOKIE}=${otherPending}`},f.options);
  assert.match(mismatch.headers.get('location'),/error=oauth_state_invalid/);
  env.DB.raw.close();
});

test('oauth state is single use and cannot be replayed with a fresh preauth',async()=>{
  const env=githubEnv();const f=githubFixture();
  const start=await get(env,'/api/oauth/github/start',{},f.options);
  const preauth=cookieFrom(start,PREAUTH_COOKIE);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const query=`state=${encodeURIComponent(state)}&code=auth-code`;
  const first=await get(env,`/api/oauth/github/callback?${query}`,{cookie:`${PREAUTH_COOKIE}=${preauth.value}`},f.options);
  assert.equal(first.status,302);
  assert.match(first.headers.get('location'),/connected=github/);
  // The state row is gone; replaying with the same preauth fails.
  const replay=await get(env,`/api/oauth/github/callback?${query}`,{cookie:`${PREAUTH_COOKIE}=${preauth.value}`},f.options);
  assert.match(replay.headers.get('location'),/error=oauth_state_invalid/);
  assert.equal((await all(env,'SELECT COUNT(*) AS n FROM pa_connections'))[0].n,1);
  assert.equal(f.counters.exchange,1);
  env.DB.raw.close();
});

test('logout clears session and preauth cookies only for same-origin posts',async()=>{
  const env=githubEnv();
  const session=await sign({user:CONNECTION_USER,login:'octocat'},{secret:SESSION_KEY,context:SESSION_CONTEXT,ttlMs:SESSION_TTL_MS});
  const preauth=await sign({user:'pending'},{secret:SESSION_KEY,context:PREAUTH_CONTEXT,ttlMs:PREAUTH_TTL_MS});
  const cookies=`${SESSION_COOKIE}=${session}; ${PREAUTH_COOKIE}=${preauth}`;
  const crossOrigin=await post(env,'/api/logout',{cookie:cookies,origin:'https://evil.test'});
  assert.equal(crossOrigin.status,403);
  const done=await post(env,'/api/logout',{cookie:cookies,origin:'https://example.test'});
  assert.equal(done.status,200);
  assert.deepEqual(await done.json(),{ok:true});
  const cleared=done.headers.getSetCookie().filter(c=>/Max-Age=0/.test(c)).map(c=>c.split('=')[0]);
  assert.deepEqual(cleared.sort(),[PREAUTH_COOKIE,SESSION_COOKIE].sort());
  // A compliant client drops the cookies; a fresh request is unauthenticated again.
  const after=await get(env,'/api/state',{});
  assert.equal(after.status,401);
  assert.equal((await after.json()).loginUrl,'/api/oauth/github/start');
  // A session token sent in the preauth cookie slot is rejected (context binding).
  const wrongSlot=await get(env,'/api/state',{cookie:`${PREAUTH_COOKIE}=${session}`});
  assert.equal(wrongSlot.status,401);
  env.DB.raw.close();
});

test('session cookie expiry and malformed cookies degrade to 401, never 500',async()=>{
  const env=githubEnv();
  const expired=await sign({user:CONNECTION_USER,login:'octocat'},{secret:SESSION_KEY,context:SESSION_CONTEXT,ttlMs:SESSION_TTL_MS,now:Date.now()-SESSION_TTL_MS-1000});
  assert.equal((await get(env,'/api/state',{cookie:`${SESSION_COOKIE}=${expired}`})).status,401);
  assert.equal((await get(env,'/api/state',{cookie:`${SESSION_COOKIE}=garbage.value`})).status,401);
  assert.equal((await get(env,'/api/state',{cookie:'malformed'})).status,401);
  assert.equal((await get(env,'/api/state',{cookie:`${SESSION_COOKIE}=`})).status,401);
  env.DB.raw.close();
});

test('runner and service endpoints keep their separate credentials in GitHub mode',async()=>{
  const env=githubEnv({PA_SERVICE_TOKEN:'service-secret'});
  const runner=new Request('https://example.test/api/runner/tick',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer wrong'},body:JSON.stringify({projectId:'p'})});
  assert.equal((await route(runner,env,'')).status,401);
  const service=new Request('https://example.test/api/service/tick',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer wrong'},body:JSON.stringify({})});
  assert.equal((await route(service,env,'')).status,401);
  env.DB.raw.close();
});

test('Sites mode preserves trusted header behavior and needs no cookies',async()=>{
  const env={DB:database(),PA_ORIGIN:'https://example.test',PA_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64'),PA_GITHUB_CLIENT_ID:'gh-client',PA_GITHUB_CLIENT_SECRET:'gh-secret'};
  const f=githubFixture();
  const anonymous=await get(env,'/api/state',{},f.options);
  assert.equal(anonymous.status,401);
  assert.equal((await anonymous.json()).loginUrl,undefined);
  const trusted=await get(env,'/api/state',{'oai-authenticated-user-id':'sites-user'},f.options);
  assert.equal(trusted.status,200);
  const body=await trusted.json();
  assert.equal(body.connectors.find(c=>c.id==='github').status,'disconnected');
  // Same-origin enforcement still applies to writes.
  assert.equal((await post(env,'/api/connectors/github/settings',{'oai-authenticated-user-id':'sites-user',origin:'https://evil.test'},{clientId:'x'})).status,403);
  assert.equal((await post(env,'/api/connectors/github/settings',{'oai-authenticated-user-id':'sites-user',origin:'https://example.test'},{clientId:'id',clientSecret:'secret'})).status,200);
  // Connector OAuth start/callback with a trusted header keeps the old shape: no cookies involved.
  const start=await get(env,'/api/oauth/github/start',{'oai-authenticated-user-id':'sites-user'},f.options);
  assert.equal(start.status,302);
  assert.equal(start.headers.getSetCookie().length,0);
  const state=new URL(start.headers.get('location')).searchParams.get('state');
  const callback=await get(env,`/api/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`,{'oai-authenticated-user-id':'sites-user'},f.options);
  assert.equal(callback.status,302);
  assert.match(callback.headers.get('location'),/connected=github/);
  const connection=(await all(env,'SELECT * FROM pa_connections'))[0];
  assert.equal(connection.user_id,'sites-user');
  env.DB.raw.close();
});

test('reauthorization in GitHub mode refuses to silently switch GitHub accounts',async()=>{
  const env=githubEnv();const f=githubFixture();
  const p=new Platform(env,{fetcher:f.fetcher,providers:f.providers});
  const seededId='github-'+await hash(CONNECTION_USER);
  await p.store.connect({id:seededId,user:CONNECTION_USER,provider:'github',kind:'project',identity:{id:'9750',name:'octocat'},credential:'{}'});
  const begin=await p.begin(CONNECTION_USER,'github');
  const state=new URL(begin).searchParams.get('state');
  // Same account: reauthorization succeeds.
  await p.callback(CONNECTION_USER,'github',new URLSearchParams({state,code:'auth-code'}));
  // A different GitHub account is rejected instead of overwriting the connection.
  const second=new URL(await p.begin(CONNECTION_USER,'github')).searchParams.get('state');
  f.providers.identity=async()=>({id:'424242',name:'octocat'});
  await assert.rejects(()=>p.callback(CONNECTION_USER,'github',new URLSearchParams({state:second,code:'auth-code'})),{code:'different_account_disconnect_first'});
  const rows=(await all(env,'SELECT COUNT(*) AS n FROM pa_connections'));
  assert.equal(rows[0].n,1);
  env.DB.raw.close();
});
