import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {Execution} from '../execution.mjs';
import {route} from '../http.mjs';
import {scanSource} from '../sources.mjs';
import {schedule,enqueueUser,consume} from '../scheduler.mjs';
import {Fault,open} from '../security.mjs';
import {sessionCookie} from '../auth.mjs';

function fixture(){
 let now=1795080000000;const sent=[],modelCalls=[],tokenCalls=[];
 const env={DB:database(),PA_ORIGIN:'https://example.test',PA_AUTH_MODE:'github',PA_SIGNUP_MODE:'open',PA_SESSION_KEY:Buffer.alloc(32,7).toString('base64'),PA_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64'),PA_BIGMODEL_KEY:'deployer-key-never-share',PA_FEISHU_OPEN_ID:'ou_deployer',PA_USER_JOBS:{send:async body=>sent.push(body)}};
 for(const name of ['GITHUB','LINEAR','FEISHU']){env['PA_'+name+'_CLIENT_ID']=name+'-client';env['PA_'+name+'_CLIENT_SECRET']=name+'-secret';}
 const providers={
  identity:async(provider,token)=>({id:provider==='feishu'?'ou_'+token.at(-1):provider+'-'+token.at(-1),name:provider==='github'?token.at(-1):'Account '+token.at(-1)}),
  projects:async(provider,token)=>[{externalId:'same-project-id',name:'Project '+token.at(-1),url:'https://example.test/'+provider,metadata:{teams:[{id:'team',name:'Team'}]}}],
  repository:async(token,repo)=>({name:repo,defaultBranch:'main'}),
  meetings:async()=>({items:[{externalId:'SharedMeeting0001',title:'Test',url:'https://example.feishu.cn/minutes/SharedMeeting0001'}],nextPage:null}),
  transcript:async token=>'Project '+token.at(-1)+' should add search.',
 };
 const fetcher=async(url,options={})=>{
  if(url.includes('/oauth/')&&url.endsWith('/token')||url.endsWith('/login/oauth/access_token')){
   const values=options.headers['content-type']==='application/json'?JSON.parse(options.body):Object.fromEntries(new URLSearchParams(options.body));tokenCalls.push(values);
   const access=values.code??values.refresh_token.replace(/^refresh-/,'');
   return Response.json({access_token:access,refresh_token:'refresh-'+access,expires_in:3600});
  }
  if(url.includes('/managed/v1/agents?'))return Response.json({data:[]});
  if(url.includes('/chat/completions')){
   const input=JSON.parse(options.body),transcript=input.messages.at(-1).content,who=/Project ([AB])/.exec(transcript)[1];
   modelCalls.push({who,key:options.headers.authorization});
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({actions:[{title:'Project '+who+' search',goal:'Add search',project:'Project '+who,evidence:transcript,acceptance:['Search works']}]})}}]});
  }
  throw Error('Unexpected '+url);
 };
 const p=new Platform(env,{providers,fetcher,now:()=>now});
 async function authorize(who,provider){const url=new URL(await p.begin('user-'+who,provider));return p.callback('user-'+who,provider,new URLSearchParams({state:url.searchParams.get('state'),code:provider+':'+who}));}
 async function setup(who,provider='github'){
  const user='user-'+who;await p.register(user,who);
  const gh=await authorize(who,'github'),source=provider==='github'?gh:await authorize(who,provider);
  await p.saveAgent(user,{apiKey:'personal-key-'+who});const meeting=await authorize(who,'feishu');
  const project=(await p.store.all('SELECT * FROM pa_projects WHERE connection_id=?',source.id))[0];
  await p.bind(user,project.id,{repo:'owner/repo-'+who,githubConnectionId:gh.id,agent:'bigmodel',validation:['npm test'],allowedPaths:['src/','test/'],automatic:true});
  return {user,gh,meeting,project:await p.store.own('projects',project.id,user)};
 }
 async function cookie(who){return (await sessionCookie({user:'user-'+who,login:who},{secret:env.PA_SESSION_KEY})).split(';')[0];}
 return {p,env,providers,fetcher,modelCalls,tokenCalls,sent,setup,authorize,cookie,advance:ms=>now+=ms};
}

test('two users own separate Feishu grants, projects, model keys and replay receipts',async()=>{
 const f=fixture(),a=await f.setup('A'),b=await f.setup('B','linear');
 assert.notEqual(a.project.id,b.project.id);
 await scanSource(f.p,a.meeting);await scanSource(f.p,b.meeting);
 for(let n=0;n<2;n++){await scanSource(f.p,a.meeting);await scanSource(f.p,b.meeting);}
 assert.deepEqual(f.modelCalls,[{who:'A',key:'Bearer personal-key-A'},{who:'B',key:'Bearer personal-key-B'}]);
 const stateA=await f.p.state(a.user),stateB=await f.p.state(b.user);
 assert.equal(stateA.tasks.length,1);assert.equal(stateB.tasks.length,1);assert.notEqual(stateA.tasks[0].id,stateB.tasks[0].id);
 assert.equal(stateA.tasks[0].project_id,a.project.id);assert.equal(stateB.tasks[0].project_id,b.project.id);
 for(const s of [stateA,stateB]){const text=JSON.stringify(s);assert.equal(text.includes('personal-key'),false);assert.equal(text.includes('deployer-key'),false);assert.equal(text.includes('refresh-'),false);}
 assert.equal(JSON.stringify(stateA).includes('Project B'),false);
 await assert.rejects(()=>f.p.store.own('tasks',stateB.tasks[0].id,a.user),{code:'not_found'});
 f.env.DB.raw.close();
});

test('a new user cannot inherit the deployment Agent key or pilot Feishu identity',async()=>{
 const f=fixture();await f.p.register('new','NewUser');
 await assert.rejects(()=>f.p.activate('new','bigmodel'),{code:'agent_key_missing'});
 await assert.rejects(()=>f.p.activate('new','feishu'),{code:'unknown_connector'});
 await assert.rejects(()=>f.p.agentKey('new'),{code:'agent_not_connected'});
 const state=await f.p.state('new');assert.equal(state.connectors.find(c=>c.id==='bigmodel').configured,false);assert.equal(JSON.stringify(state).includes('ou_deployer'),false);
 f.env.DB.raw.close();
});

test('another user cannot overwrite repository runner credentials, and a failed claim preserves bindings',async()=>{
 const f=fixture(),a=await f.setup('A'),b=await f.setup('B');
 await assert.rejects(()=>f.p.bind(b.user,b.project.id,{...b.project.binding,repo:a.project.binding.repo}),{code:'repository_already_managed'});
 const bAfter=await f.p.store.own('projects',b.project.id,b.user);assert.equal(bAfter.binding.repo,'owner/repo-B');
 assert.equal((await f.p.store.one('SELECT * FROM pa_repo_claims WHERE repo=?','owner/repo-b')).user_id,b.user);
 await f.p.unbind(a.user,a.project.id);
 await f.p.bind(b.user,b.project.id,{...b.project.binding,repo:a.project.binding.repo});
 assert.equal((await f.p.store.one('SELECT * FROM pa_repo_claims WHERE repo=?','owner/repo-a')).user_id,b.user);
 f.env.DB.raw.close();
});

test('OAuth configuration and refresh remain bound to the application used for authorization',async()=>{
 const f=fixture();await f.p.register('user-A','A');const url=new URL(await f.p.begin('user-A','feishu'));
 await f.p.settings('user-A','feishu',{clientId:'replacement-app',clientSecret:'replacement-secret'});
 const conn=await f.p.callback('user-A','feishu',new URLSearchParams({state:url.searchParams.get('state'),code:'feishu:A'}));
 assert.equal(f.tokenCalls[0].client_id,'FEISHU-client');assert.ok(f.tokenCalls[0].code_verifier);
 f.advance(3600000);await f.p.access(conn);
 assert.equal(f.tokenCalls.at(-1).client_id,'FEISHU-client');assert.equal(f.tokenCalls.at(-1).client_secret,'FEISHU-secret');
 const saved=await f.p.store.connection('user-A','feishu');const value=await open(f.env.PA_ENCRYPTION_KEY,saved.credential,saved.id);assert.equal(value.oauthClient.clientId,'FEISHU-client');
 f.env.DB.raw.close();
});

test('one failed user job does not prevent another user from progressing; delivery is idempotent',async()=>{
 const f=fixture();await f.setup('A');await f.setup('B');await schedule(f.env,'',{platform:f.p});await schedule(f.env,'',{platform:f.p});
 assert.equal(f.sent.length,2);assert.equal(JSON.stringify(f.sent).includes('key'),false);
 const outcomes=[],ticks=[];const messages=f.sent.map(body=>({body,ack:()=>outcomes.push(body.userId+':ack'),retry:()=>outcomes.push(body.userId+':retry')}));
 const options={platform:f.p,execution:{tick:async(_,user)=>{ticks.push(user);return {processed:1,synced:0};}},scan:async(_,source)=>{if(source.user_id==='user-A')throw new Fault(502,'feishu_temporary');return {ingested:1};}};
 await consume({messages},f.env,'',options);
 assert.deepEqual(outcomes,['user-A:retry','user-B:ack']);assert.deepEqual(ticks,['user-B']);
 await consume({messages:[messages[1]]},f.env,'',options);assert.deepEqual(ticks,['user-B']);
 const a=await f.p.state('user-A'),b=await f.p.state('user-B');assert.equal(a.schedulerLast.status,'failed');assert.equal(b.schedulerLast.status,'completed');assert.equal(b.schedulerLast.error,null);
 f.env.DB.raw.close();
});

test('session APIs reject cross-user mutations and return only the current account data',async()=>{
 const f=fixture(),a=await f.setup('A'),b=await f.setup('B');
 const opts={providers:f.providers,fetcher:f.fetcher,now:f.p.now},headers={cookie:await f.cookie('A'),origin:f.env.PA_ORIGIN,'content-type':'application/json'};
 const call=(path,data)=>route(new Request(f.env.PA_ORIGIN+'/api/'+path,{method:data?'POST':'GET',headers,body:data?JSON.stringify(data):undefined}),f.env,'',opts);
 assert.equal((await call('connectors/'+b.meeting.id+'/disconnect',{})).status,404);
 assert.equal((await call('projects/'+b.project.id+'/unbind',{})).status,404);
 const state=await (await call('state')).json();assert.equal(state.account.login,'A');assert.equal(JSON.stringify(state).includes('Project B'),false);
 await f.p.store.run('UPDATE pa_users SET disabled_at=? WHERE id=?',f.p.now(),a.user);assert.equal((await call('state')).status,401);
 f.env.DB.raw.close();
});

test('binding a project automatically resolves this users pending meeting task',async()=>{
 const f=fixture();await f.p.register('user-A','A');await f.p.saveAgent('user-A',{apiKey:'personal-key-A'});const meeting=await f.authorize('A','feishu');
 await scanSource(f.p,meeting);let task=(await f.p.state('user-A')).tasks[0];assert.equal(task.status,'needs_project');
 const gh=await f.authorize('A','github'),project=(await f.p.state('user-A')).projects[0];
 await f.p.bind('user-A',project.id,{repo:'owner/repo-A',githubConnectionId:gh.id,agent:'bigmodel',validation:['npm test'],allowedPaths:['src/'],automatic:true});
 task=(await f.p.state('user-A')).tasks[0];assert.equal(task.status,'queued');assert.equal(task.project_id,project.id);
 f.env.DB.raw.close();
});

test('a disabled account cannot use an already installed runner credential',async()=>{
 const f=fixture(),a=await f.setup('A');const ex=new Execution(f.p,'');
 const binding={...a.project.binding,runnerReady:true,runnerTokenHash:await (await import('../security.mjs')).hash('runner-secret')};
 await f.p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(binding),a.project.id);
 assert.equal((await ex.runnerProject(a.project.id,'runner-secret')).user_id,a.user);
 await f.p.store.run('UPDATE pa_users SET disabled_at=? WHERE id=?',f.p.now(),a.user);
 await assert.rejects(()=>ex.runnerProject(a.project.id,'runner-secret'),{code:'runner_unauthorized'});
 f.env.DB.raw.close();
});

test('a source resumes pagination, skips not-ready transcripts and catches late indexing without replay',async()=>{
 const f=fixture(),a=await f.setup('A');let phase=0;const seen=[];
 const item=n=>({externalId:'MeetingNumber000'+n,title:'Project A',url:'https://example.feishu.cn/minutes/MeetingNumber000'+n});
 f.providers.meetings=async(_,__,cursor)=>{seen.push({...cursor});return cursor.pageToken?{items:[item(3)],nextPage:null}:{items:phase?[item(1),item(2),item(4)]:[item(1),item(2)],nextPage:'page-2'};};
 let pending=true;f.providers.transcript=async(_,id)=>{if(id.endsWith('2')&&pending)throw new Fault(409,'transcript_not_ready');return 'Project A should add search.';};
 // Bootstrap ingests only the latest readable meeting; future scans include
 // enrollment onward and persist the offset across bounded user jobs.
 await scanSource(f.p,a.meeting);await scanSource(f.p,a.meeting);
 await scanSource(f.p,a.meeting);await scanSource(f.p,a.meeting);
 phase=1;pending=false;
 for(let i=0;i<6;i++)await scanSource(f.p,a.meeting);
 assert.equal(f.modelCalls.length,4);
 const state=await f.p.state(a.user);assert.equal(state.tasks.length,4);
 assert.ok(seen.some(c=>c.pageToken==='page-2'));
 assert.ok(seen.slice(1).every(c=>c.since>=1795080000000));
 f.env.DB.raw.close();
});

test('Feishu authorization failures suspend only the affected source while other users still run',async()=>{
 const f=fixture();await f.setup('A');await f.setup('B');await schedule(f.env,'',{platform:f.p});const outcomes=[];
 await consume({messages:f.sent.map(body=>({body,ack:()=>outcomes.push(body.userId),retry:()=>assert.fail('authorization errors must not retry forever')}))},f.env,'',{platform:f.p,execution:{tick:async()=>({processed:0})},scan:async(_,source)=>{if(source.user_id==='user-A')throw new Fault(401,'feishu_api_99991671');return {ingested:0};}});
 assert.deepEqual(outcomes,['user-A','user-B']);assert.equal((await f.p.store.connection('user-A','feishu')).status,'needs_auth');assert.equal((await f.p.store.connection('user-B','feishu')).status,'connected');
 f.env.DB.raw.close();
});


test('recent meetings use only the signed-in users Feishu grant and bounded search window',async()=>{
 const f=fixture();await f.setup('A');await f.setup('B');const calls=[];
 f.providers.meetings=async(token,owner,window)=>{calls.push({token,owner,window});return {items:[{externalId:'MeetingA00001',title:'Private A'}],nextPage:null};};
 const request=path=>new Request(f.env.PA_ORIGIN+path,{headers:{cookie:cookie}}),cookie=await f.cookie('A');
 const response=await route(request('/api/meetings/recent?scope=new'),f.env,'',{providers:f.providers,fetcher:f.fetcher,now:f.p.now});
 assert.equal(response.status,200);assert.equal(calls.length,1);assert.equal(calls[0].token,'feishu:A');assert.equal(calls[0].owner,'ou_A');assert.equal(calls[0].window.since,1795080000000);
 const body=await response.json();assert.equal(body.items[0].title,'Private A');assert.equal(JSON.stringify(body).includes('feishu:A'),false);
 assert.equal((await route(new Request(f.env.PA_ORIGIN+'/api/meetings/recent'),f.env,'')).status,401);f.env.DB.raw.close();
});


test('delivery verification uses the task owners repository grant and rejects foreign tasks',async()=>{
 const f=fixture(),a=await f.setup('A');await f.setup('B');const id='task-audit-0123456789abcdef';
 await f.p.store.putTask({id,userId:a.user,projectId:a.project.id,meetingKey:'meeting-audit',createdAt:f.p.now(),githubRunId:'7',original:{id:'1'},result:{pr:'https://github.com/owner/repo-A/pull/2'}},'review_ready');
 const calls=[];f.providers.gh=async(token,path)=>{calls.push({token,path});if(path.includes('/comments?'))return [{id:1,body:'Result <!-- progressive-agent:'+id+':pr -->'}];if(path.includes('/jobs?'))return {jobs:[{name:'verify',status:'completed',conclusion:'success'}]};if(path.includes('/actions/runs/'))return {id:7,status:'completed',conclusion:'success',run_attempt:1};if(path.includes('/pulls?'))return [{number:2}];return {number:2,state:'open',draft:true,head:{sha:'head'}};};
 const ex=new Execution(f.p,'');await assert.rejects(()=>ex.verification('user-B',id),{code:'not_found'});assert.equal(calls.length,0);
 const result=await ex.verification(a.user,id);assert.equal(result.jobs[0].conclusion,'success');assert.equal(result.backfill.comments.length,1);assert.equal(result.pullCount,1);assert.equal(result.pull.draft,true);assert.ok(calls.every(c=>c.token==='github:A'&&c.path.startsWith('/repos/owner/repo-A/')));
 const cookie=await f.cookie('A'),url=f.env.PA_ORIGIN+'/api/tasks/'+id+'/verification';assert.equal((await route(new Request(url,{headers:{cookie}}),f.env,'',{providers:f.providers,fetcher:f.fetcher,now:f.p.now})).status,200);f.env.DB.raw.close();
});

for(const status of [401,502])test('a '+status+' failure in one source still drains this users independent Webhook and advances its tasks',async()=>{
 const f=fixture(),a=await f.setup('A'),{rotateWebhook,receiveMeeting}=await import('../meeting-webhook.mjs');await rotateWebhook(f.p,a.user);const webhook=await f.p.store.connection(a.user,'meeting-webhook');await receiveMeeting(f.p,webhook,{externalId:'beta-isolation',title:'Independent meeting',todos:[{id:'t1',content:'Unclear; wait for confirmation'}],notes:[]});let reads=0,ticks=0,acks=0,retries=0,fail=true;
 f.p.ingest=async(source)=>{assert.equal(source.id,webhook.id);reads++;return {taskIds:[]};};await enqueueUser(f.p,a.user);const message={body:f.sent[0],ack:()=>acks++,retry:()=>retries++},options={platform:f.p,execution:{tick:async()=>{ticks++;return {processed:0};}},scan:async()=>{if(fail)throw new Fault(status,'feishu_unavailable');return {ingested:0};}};
 await consume({messages:[message]},f.env,'',options);assert.equal(reads,1);assert.equal(ticks,1);assert.equal((await f.p.state(a.user)).schedulerLast.status,'partial');assert.equal((await f.p.store.connection(a.user,'meeting-webhook')).status,'connected');assert.equal((await f.p.store.connection(a.user,'feishu')).status,status===401?'needs_auth':'connected');
 if(status===502){assert.equal(retries,1);fail=false;await consume({messages:[message]},f.env,'',options);assert.equal(reads,1);assert.equal((await f.p.state(a.user)).schedulerLast.status,'completed');}else assert.equal(acks,1);f.env.DB.raw.close();
});

test('a revoked account cannot enqueue work and a repository authorization failure never suspends Feishu',async()=>{
 const f=fixture(),a=await f.setup('A');await f.p.store.run('UPDATE pa_users SET disabled_at=? WHERE id=?',f.p.now(),a.user);assert.deepEqual(await enqueueUser(f.p,a.user),{queued:false,reason:'account_disabled'});assert.equal(f.sent.length,0);await f.p.store.run('UPDATE pa_users SET disabled_at=NULL WHERE id=?',a.user);await enqueueUser(f.p,a.user);
 await consume({messages:[{body:f.sent[0],ack:()=>{},retry:()=>assert.fail('permanent error should be acknowledged')}]},f.env,'',{platform:f.p,execution:{tick:async()=>{throw new Fault(401,'repository_token_invalid');}},scan:async()=>({ingested:0})});assert.equal((await f.p.store.connection(a.user,'feishu')).status,'connected');f.env.DB.raw.close();
});

test('a source failure cannot reactivate a connector disconnected while discovery was in flight',async()=>{const f=fixture(),a=await f.setup('A');await enqueueUser(f.p,a.user);await consume({messages:[{body:f.sent[0],ack:()=>{},retry:()=>{}}]},f.env,'',{platform:f.p,execution:{tick:async()=>({processed:0})},scan:async()=>{await f.p.disconnect(a.user,a.meeting.id);throw new Fault(502,'late_provider_failure');}});const source=await f.p.store.connection(a.user,'feishu');assert.equal(source.status,'disconnected');assert.equal(source.credential,null);f.env.DB.raw.close();});

test('removing an uninvited account from operator admission also blocks queued work and installed runners',async()=>{const f=fixture(),a=await f.setup('A'),secret='old-runner';const binding={...a.project.binding,runnerReady:true,runnerTokenHash:await (await import('../security.mjs')).hash(secret)};await f.p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(binding),a.project.id);f.env.PA_SIGNUP_MODE='allowlist';f.env.PA_ALLOWED_GITHUB_LOGINS='B';assert.deepEqual(await enqueueUser(f.p,a.user),{queued:false,reason:'account_disabled'});await assert.rejects(()=>new Execution(f.p,'').runnerProject(a.project.id,secret),{code:'runner_unauthorized'});f.env.DB.raw.close();});


test('manual meeting checks explain missing setup and distinguish queue deduplication',async()=>{
 const f=fixture();await f.p.register('user-A','A');
 assert.deepEqual(await enqueueUser(f.p,'user-A'),{queued:false,reason:'meeting_not_connected'});
 const meeting=await f.authorize('A','feishu');
 const headers={cookie:await f.cookie('A'),origin:f.env.PA_ORIGIN,'content-type':'application/json'};
 const check=path=>route(new Request(f.env.PA_ORIGIN+'/api/'+path,{method:'POST',headers,body:'{}'}),f.env,'',{providers:f.providers,fetcher:f.fetcher,now:f.p.now});
 for(const path of ['check','connectors/'+meeting.id+'/sync']){
  const response=await check(path);assert.equal(response.status,200);assert.deepEqual(await response.json(),{queued:false,reason:'agent_not_connected'});
 }
 assert.equal(f.sent.length,0);assert.equal((await f.p.store.all('SELECT * FROM pa_jobs')).length,0);
 await f.p.saveAgent('user-A',{apiKey:'personal-key-A'});
 assert.deepEqual(await (await check('connectors/'+meeting.id+'/sync')).json(),{queued:true});
 assert.deepEqual(await (await check('check')).json(),{queued:false,reason:'already_scheduled'});
 assert.equal(f.sent.length,1);f.env.DB.raw.close();
});
