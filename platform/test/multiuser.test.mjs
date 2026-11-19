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
