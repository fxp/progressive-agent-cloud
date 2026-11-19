import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {Execution,allowedPath,workflow,WORKFLOW_PATH} from '../execution.mjs';
import {Providers} from '../providers.mjs';
import {route} from '../http.mjs';
import {Fault,seal,open,hash,matchProject,validateBinding} from '../security.mjs';

const owner='owner',base='a'.repeat(40),patchChecksum='b'.repeat(64);
test('Linear PKCE uses the verifier without a client secret',async()=>{
 const env={DB:database()};let input;
 const p=new Platform(env,{fetcher:async(url,options)=>{input=new URLSearchParams(options.body);return Response.json({access_token:'test'});}});
 await p.tokenRequest('linear',{client_id:'id',client_secret:'unused',code_verifier:'verifier',code:'code'});
 assert.equal(input.get('code_verifier'),'verifier');assert.equal(input.has('client_secret'),false);env.DB.raw.close();
});
test('runtime fetch keeps the global receiver for OAuth and provider requests',async()=>{
 const calls=[];
 function fetcher(url){assert.equal(this,globalThis);calls.push(url);return Promise.resolve(Response.json(url.includes('/login/oauth/')?{access_token:'test'}:{id:1,login:'owner'}));}
 const p=new Platform({DB:database()},{fetcher});
 await p.tokenRequest('github',{code:'code'});
 assert.deepEqual(await p.providers.identity('github','test'),{id:'1',name:'owner'});
 assert.equal(calls.length,2);p.env.DB.raw.close();
});
function fixture(provider='github'){
 const env={DB:database(),PA_ORIGIN:'https://example.test',PA_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64'),PA_BIGMODEL_KEY:'test-model-key',PA_SERVICE_TOKEN:'test-service'};
 let projects=[{externalId:'external-project',name:'Focus Board',description:'Product work',url:'https://example.test/project',metadata:{teams:[{id:'team-1',name:'Product'}]}}];
 let taskId,head,pr,verify=true,backfillFailure=false,dispatchFailure=false,workflowRuns=[],runState={};
 const counters={extract:0,issues:0,dispatch:0,pr:0,backfill:0,blobs:0};
 const providers={
  identity:async p=>({id:p+'-account',name:'Test Workspace'}),projects:async()=>projects,
  repositories:async()=>[{name:'acme/board'}],repository:async()=>({name:'acme/board',defaultBranch:'main'}),
  issue:async(p,t,project,task)=>{counters.issues++;return {id:'issue-1',url:p==='github'?'https://github.com/acme/board/issues/1':'https://linear.app/acme/issue/ABC-1'};},
  backfill:async()=>{counters.backfill++;if(backfillFailure)throw new Fault(502,'backfill_transient');},
  async gh(token,path,body,method){
   if(path.includes('/actions/workflows/')&&path.includes('/runs?'))return {workflow_runs:workflowRuns};
   if(path.endsWith('/dispatches')){counters.dispatch++;taskId=body.inputs.task_id;if(dispatchFailure)throw new Fault(502,'dispatch_response_lost');return {};}
   if(path.includes('/actions/runs/')&&path.includes('/jobs'))return {jobs:[{name:'verify',conclusion:verify?'success':'failure'}]};
   if(path.includes('/actions/runs/'))return {...runState,run_attempt:1,path:WORKFLOW_PATH,display_title:'PA '+taskId,event:'workflow_dispatch',head_sha:'c'.repeat(40),html_url:'https://github.com/acme/board/actions/runs/9'};
   if(path.includes('/contents/'))return {sha:path.includes('runner.mjs')?'runner-sha':'workflow-sha'};
   if(path.includes('/git/ref/heads/')){if(head)return {object:{sha:head}};throw new Fault(502,'provider_http_404');}
   if(path.includes('/git/commits/')&&method===undefined)return {tree:{sha:'tree-base'},message:'[PA:'+taskId+']'};
   if(path.endsWith('/git/blobs')){counters.blobs++;return {sha:'blob'};}
   if(path.endsWith('/git/trees'))return {sha:'tree'};
   if(path.endsWith('/git/commits'))return {sha:'f'.repeat(40)};
   if(path.endsWith('/git/refs')){head=body.sha;return {};}
   if(path.includes('/pulls?'))return pr?[pr]:[];
   if(path.endsWith('/pulls')){counters.pr++;pr={html_url:'https://github.com/acme/board/pull/1',head:{sha:head}};return pr;}
   throw Error('Unhandled test request '+path);
  },
 };
 const fetcher=async(url,options)=>{
  if(url.includes('/oauth/')||url.includes('/login/oauth/'))return Response.json({access_token:'oauth-access',refresh_token:'oauth-refresh',expires_in:3600});
  if(url.includes('/chat/completions')){counters.extract++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({actions:[{title:'Focus Board add search',goal:'Add title search to Focus Board',project:'Focus Board',acceptance:['Search filters the list'],evidence:'Focus Board should add title search.'}]})}}]});}
  throw Error('Unexpected fetch '+url);
 };
 const p=new Platform(env,{fetcher,providers});const ex=new Execution(p,'// test runner');
 async function authorize(name=provider,user=owner){
  await p.settings(user,name,{clientId:'test-client',clientSecret:'test-secret'});
  const url=new URL(await p.begin(user,name));
  const c=await p.callback(user,name,new URLSearchParams({state:url.searchParams.get('state'),code:'test-code'}));return c;
 }
 async function setup(){
  const source=await authorize();const github=provider==='github'?source:await authorize('github');
  await p.activate(owner,'bigmodel');const meeting=await p.activate(owner,'feishu').catch(async()=>{env.PA_FEISHU_OPEN_ID='ou_test';return p.activate(owner,'feishu');});
  const project=(await p.store.all('SELECT * FROM pa_projects WHERE connection_id=?',source.id))[0];
  // A second source can expose the same project name. Keep only the selected source in scope.
  await p.bind(owner,project.id,{repo:'acme/board',githubConnectionId:github.id,agent:'bigmodel',validation:['npm test'],allowedPaths:['src/','test/'],automatic:true});
  const ready=await p.store.own('projects',project.id,owner);ready.binding.runnerReady=true;ready.binding.workflowSha='workflow-sha';ready.binding.runnerSha='runner-sha';
  await p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(ready.binding),ready.id);
  return {project:ready,meeting};
 }
 return {env,p,ex,providers,fetcher,counters,authorize,setup,setProjects:value=>projects=value,setVerify:value=>verify=value,setBackfillFailure:value=>backfillFailure=value,setRunState:value=>runState=value,setRuns:value=>workflowRuns=value,setDispatchFailure:value=>dispatchFailure=value};
}
async function queued(f){
 const {project,meeting}=await f.setup();
 const input={externalId:'meeting-1',title:'Focus Board weekly',url:'https://feishu.cn/minutes/test',transcript:'Focus Board should add title search.'};
 const result=await f.p.ingest(meeting,input);const id=result.taskIds[0];await f.ex.tick();
 await f.ex.claim(project,{taskId:id,runId:'9'});
 await f.ex.checkpoint(project,{taskId:id,runId:'9',session:{id:'session-1',base},patchChecksum});
 return {project,meeting,input,id,complete:{taskId:id,runId:'9',base,patchChecksum,files:[{path:'src/app.js',mode:'100644',content:Buffer.from('export const search=true;').toString('base64')}]}};
}
for(const approved of [false,true])test('evidenced task publication '+(approved?'reuses a successful review across replays':'blocks an unsupported feature before any GitHub write'),async()=>{
 const f=fixture(),t=await queued(f);let reviews=0;
 const originalFetch=f.p.fetch;f.p.fetch=async(url,options)=>{
  if(url.includes('/chat/completions')){reviews++;assert.match(JSON.parse(options.body).messages[0].content,/PA_FIDELITY_code/);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({approved,violations:approved?[]:['An extra option was not requested']})}}]});}
  return originalFetch(url,options);
 };
 const row=await f.p.store.own('tasks',t.id,owner);row.payload.fidelityVersion=1;row.payload.sourceEvidence=[{sourceId:'chapter:0',kind:'chapter',quote:'Only the requested search feature is allowed.'}];await f.p.store.saveTask(row);
 if(approved){await f.ex.complete(t.project,t.complete);for(let i=0;i<2;i++)await f.ex.complete(t.project,t.complete);assert.equal(f.counters.pr,1);assert.equal(f.counters.backfill,1);}
 else{await assert.rejects(()=>f.ex.complete(t.project,t.complete),{code:'requirement_fidelity_failed'});assert.equal(f.counters.pr,0);assert.equal(f.counters.blobs,0);assert.equal(f.counters.backfill,0);}
 assert.equal(reviews,1);f.env.DB.raw.close();
});
test('uncertain note supplementation remains needs_info even if a queued row is encountered',async()=>{
 const f=fixture(),{project,meeting}=await f.setup(),text='Focus Board should add title search.';
 f.p.fetch=async(url,options)=>{const extracting=JSON.parse(options.body).messages[0].content.startsWith('PA_FIDELITY_extract');return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(extracting?{actions:[{todoIds:['t1'],project:'Focus Board',criteria:[{source:'todo:t1',quote:text}]}]}:{groups:[{indices:[0],approved:false,reason:'Missing search rules'}]})}}]});};
 const result=await f.p.ingest(meeting,{externalId:'uncertain',title:'Focus Board',transcript:text,sourceKind:'meeting_todos',sourceTodos:[{id:'t1',content:text}],sourceNotes:[]});
 const row=await f.p.store.own('tasks',result.taskIds[0],owner);assert.equal(row.status,'needs_info');await f.p.store.saveTask(row,'queued');await f.ex.tick();assert.equal((await f.p.store.own('tasks',row.id,owner)).status,'needs_info');assert.equal(f.counters.dispatch,0);assert.equal(f.counters.issues,0);f.env.DB.raw.close();
});
async function rejected(f,ready=true){
 const t=await queued(f),row=await f.p.store.own('tasks',t.id,owner);
 row.payload.fidelityVersion=1;row.payload.fidelityReview={approved:false,violations:['Missing UI option-set tests'],patchChecksum};await f.p.store.saveTask(row,'failed');
 if(ready){t.project.binding.executionVersion='evidence-repair-v1';await f.p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(t.project.binding),t.project.id);}
 f.setRunState({status:'completed',conclusion:'failure'});return t;
}
test('one fidelity repair reuses task, issue and session, rejects stale run claims and stops after one revision',async()=>{
 const f=fixture(),t=await rejected(f);await f.ex.tick();let row=await f.p.store.own('tasks',t.id,owner);
 assert.equal(row.status,'dispatching');assert.equal(row.payload.repairRevision,1);assert.equal(row.payload.session.id,'session-1');assert.equal(row.payload.patchChecksum,undefined);assert.equal(row.payload.previousRejectedChecksum,patchChecksum);assert.equal(f.counters.issues,1);assert.equal(f.counters.dispatch,2);
 f.setRuns([{id:9,display_title:'PA '+t.id}]);await f.ex.tick();assert.equal(f.counters.dispatch,2);
 f.setRuns([{id:9,display_title:'PA '+t.id},{id:10,display_title:'PA '+t.id}]);await f.ex.tick();row=await f.p.store.own('tasks',t.id,owner);assert.equal(row.payload.githubRunId,'10');
 await assert.rejects(()=>f.ex.claim(t.project,{taskId:t.id,runId:'9'}),{code:'task_claimed_by_another_run'});await f.ex.claim(t.project,{taskId:t.id,runId:'10'});
 row=await f.p.store.own('tasks',t.id,owner);row.payload.fidelityReview={approved:false,violations:['Still incomplete']};await f.p.store.saveTask(row,'failed');await f.ex.tick();assert.equal(f.counters.dispatch,2);assert.equal((await f.p.store.own('tasks',t.id,owner)).status,'failed');f.env.DB.raw.close();
});
test('an ambiguous repair dispatch is reconciled instead of dispatched again',async()=>{
 const f=fixture(),t=await rejected(f);f.setDispatchFailure(true);await f.ex.tick();assert.equal((await f.p.store.own('tasks',t.id,owner)).status,'dispatching');
 f.setRuns([{id:10,display_title:'PA '+t.id}]);await f.ex.tick();assert.equal(f.counters.dispatch,2);assert.equal((await f.p.store.own('tasks',t.id,owner)).payload.githubRunId,'10');f.env.DB.raw.close();
});
test('repair requires the current runner and never retries a cancelled run',async()=>{
 const f=fixture(),t=await rejected(f,false);await f.ex.tick();let row=await f.p.store.own('tasks',t.id,owner);assert.equal(row.payload.error,'runner_installation_required');assert.equal(f.counters.dispatch,1);
 f.setRunState({status:'completed',conclusion:'cancelled'});await f.ex.tick();row=await f.p.store.own('tasks',t.id,owner);assert.equal(row.payload.repairRevision,undefined);assert.equal(f.counters.dispatch,1);f.env.DB.raw.close();
});
test('disconnecting the meeting source stops future automatic correction dispatch',async()=>{
 const f=fixture(),t=await rejected(f);await f.p.disconnect(owner,t.meeting.id);await f.ex.tick();assert.equal(f.counters.dispatch,1);assert.equal((await f.p.store.own('tasks',t.id,owner)).payload.repairRevision,undefined);f.env.DB.raw.close();
});
for(const provider of ['github','linear'])test(`${provider}: OAuth → sync → bind → meeting → cloud run → PR → original requirement; replay twice`,async()=>{
 const f=fixture(provider);const flow=await queued(f);
 const result=await f.ex.complete(flow.project,flow.complete);assert.match(result.pr,/pull\/1$/);
 assert.equal((await f.p.store.own('tasks',flow.id,owner)).status,'review_ready');
 for(let round=0;round<2;round++){assert.deepEqual((await f.p.ingest(flow.meeting,flow.input)).taskIds,[flow.id]);await f.ex.tick();await f.ex.complete(flow.project,flow.complete);}
 assert.equal(f.counters.extract,1);assert.equal(f.counters.issues,1);assert.equal(f.counters.dispatch,1);assert.equal(f.counters.pr,1);assert.equal(f.counters.backfill,1);
 f.env.DB.raw.close();
});
test('failed verification creates no commit or PR',async()=>{const f=fixture();const t=await queued(f);f.setVerify(false);await assert.rejects(()=>f.ex.complete(t.project,t.complete),{code:'verification_not_confirmed'});assert.equal(f.counters.pr,0);assert.equal(f.counters.blobs,0);});
test('backfill failure retains PR and retries only backfill',async()=>{const f=fixture();const t=await queued(f);f.setBackfillFailure(true);await assert.rejects(()=>f.ex.complete(t.project,t.complete),{code:'backfill_transient'});assert.equal((await f.p.store.own('tasks',t.id,owner)).status,'backfilling');f.setBackfillFailure(false);await f.ex.tick();assert.equal(f.counters.pr,1);assert.equal((await f.p.store.own('tasks',t.id,owner)).status,'review_ready');});
test('unsafe change and mismatched patch checksum cannot publish',async()=>{const f=fixture();const t=await queued(f);await assert.rejects(()=>f.ex.complete(t.project,{...t.complete,patchChecksum:'wrong'}),{code:'patch_checksum_mismatch'});await assert.rejects(()=>f.ex.complete(t.project,{...t.complete,files:[{path:'.github/workflows/evil.yml',mode:'100644',content:'eA=='}]}),{code:'change_outside_allowed_paths'});assert.equal(f.counters.pr,0);});
test('project rename preserves stable ID and local binding, archive stops dispatch',async()=>{const f=fixture();const {project}=await f.setup();f.setProjects([{externalId:'external-project',name:'New Board',url:'https://example.test/project'}]);await f.p.sync(owner,project.connection_id);const next=await f.p.store.own('projects',project.id,owner);assert.equal(next.name,'New Board');assert.equal(next.binding.repo,'acme/board');f.setProjects([]);await f.p.sync(owner,project.connection_id);assert.equal((await f.p.store.own('projects',project.id,owner)).active,0);});
test('OAuth state is PKCE bound, user scoped and single use',async()=>{const f=fixture();await f.p.settings(owner,'github',{clientId:'id',clientSecret:'secret'});const url=new URL(await f.p.begin(owner,'github'));assert.equal(url.searchParams.get('code_challenge_method'),'S256');const params=new URLSearchParams({state:url.searchParams.get('state'),code:'x'});await assert.rejects(()=>f.p.callback('another-user','github',params),{code:'oauth_state_invalid'});await f.p.callback(owner,'github',params);await assert.rejects(()=>f.p.callback(owner,'github',params),{code:'oauth_state_invalid'});});
test('credentials and settings use authenticated encryption and never appear in frontend state',async()=>{const f=fixture();await f.authorize();const raw=await f.p.store.connection(owner,'github');assert.ok(!raw.credential.includes('oauth-access'));const serialized=JSON.stringify(await f.p.state(owner));assert.ok(!serialized.includes('oauth-access'));assert.ok(!serialized.includes('test-secret'));const encrypted=await seal(f.env.PA_ENCRYPTION_KEY,{token:'private'},'owner');await assert.rejects(()=>open(f.env.PA_ENCRYPTION_KEY,encrypted,'other-owner'));});
test('same-name ambiguous project stays unresolved',()=>{const projects=[{id:'one',name:'Board'},{id:'two',name:'Board'}];assert.equal(matchProject({title:'Board search'},projects),null);assert.equal(matchProject({title:'unknown'},projects),null);});
test('unknown project and missing acceptance require confirmation',async()=>{const f=fixture();const {meeting}=await f.setup();f.p.extract=async()=>[{title:'Unknown product',goal:'Feature',project:'Unknown',acceptance:['Test'],evidence:'Unknown product'}];const result=await f.p.ingest(meeting,{externalId:'unknown',title:'New',transcript:'Unknown product'});assert.equal((await f.p.store.own('tasks',result.taskIds[0],owner)).status,'needs_project');await assert.rejects(()=>f.p.approve('another',result.taskIds[0],{}),{code:'not_found'});});
test('disconnect removes local token and marks projects inactive',async()=>{const f=fixture();const c=await f.authorize();await f.p.disconnect(owner,c.id);const row=await f.p.store.own('connections',c.id,owner);assert.equal(row.credential,null);assert.equal(row.status,'disconnected');assert.ok((await f.p.store.all('SELECT * FROM pa_projects WHERE connection_id=?',c.id)).every(p=>p.active===0));});
test('runner claim cannot be taken by another run and binding cannot change during execution',async()=>{const f=fixture();const t=await queued(f);await assert.rejects(()=>f.ex.claim(t.project,{taskId:t.id,runId:'99'}),{code:'task_claimed_by_another_run'});await assert.rejects(()=>f.p.bind(owner,t.project.id,{repo:'acme/board',agent:'bigmodel',validation:['npm test'],allowedPaths:['src/']}),{code:'project_has_active_run'});});
test('HTTP API enforces login, same-origin writes, service token and tenant ownership',async()=>{const f=fixture();const {project}=await f.setup();const request=(path,headers={},data)=>new Request('https://example.test/api/'+path,{method:data?'POST':'GET',headers:{'content-type':'application/json',...headers},body:data?JSON.stringify(data):undefined});assert.equal((await route(request('state'),f.env,'',{providers:f.providers})).status,401);assert.equal((await route(request('connectors/github/settings',{'oai-authenticated-user-id':owner,origin:'https://evil.test'},{clientId:'x'}),f.env,'')).status,403);assert.equal((await route(request('service/tick',{},{}),f.env,'')).status,401);assert.equal((await route(request('projects/'+project.id+'/bind',{'oai-authenticated-user-id':'other',origin:'https://example.test'},{repo:'acme/board'}),f.env,'')).status,404);});
test('validation scope rejects traversal, env and workflow paths',()=>{for(const p of ['../src/a.js','.github/a','.env','src/../../x'])assert.equal(allowedPath(p,['src/','.github/']),false);assert.equal(allowedPath('src/a.js',['src/']),true);assert.throws(()=>validateBinding({repo:'owner/repo',agent:'bigmodel',validation:[],allowedPaths:['src/']}),{code:'validation_required'});});
test('workflow separates coding, credential-free tests and publication',()=>{const text=workflow();const verify=text.split('  verify:')[1].split('  publish:')[0];assert.ok(!verify.includes('secrets.'));assert.ok(text.includes('needs: [prepare, verify]'));assert.ok(text.includes('persist-credentials: false'));assert.ok(text.includes('${{ inputs.task_id }}'));});
test('D1 task lease excludes a second worker until release',async()=>{const f=fixture();const release=await f.p.store.lease('same-task');await assert.rejects(()=>f.p.store.lease('same-task'),{code:'busy_retry_later'});await release();await (await f.p.store.lease('same-task'))();});
test('real project adapter follows all Linear pages and maps team IDs',async()=>{let count=0;const api=new Providers(async(url,options)=>{const input=JSON.parse(options.body);const after=input.variables.cursor;count++;return Response.json({data:{projects:{nodes:[{id:after?'p2':'p1',name:after?'Second':'First',description:'',url:'https://linear.app/test',teams:{nodes:[{id:'team',name:'Team'}]}}],pageInfo:{hasNextPage:!after,endCursor:after?null:'next'}}}});});const projects=await api.projects('linear','token');assert.equal(projects.length,2);assert.equal(count,2);assert.equal(projects[0].metadata.teams[0].id,'team');});
test('GraphQL partial errors are never silently accepted as successful sync',async()=>{const p=new Providers(async()=>Response.json({data:{projects:null},errors:[{message:'Permission missing'}]}));await assert.rejects(()=>p.projects('linear','token'),{code:'provider_graphql_error'});});
test('GitHub backfill retries find the existing comment marker',async()=>{let writes=0;const p=new Providers(async(url,options)=>{if(options.method==='POST')writes++;return Response.json([{body:'PR result <!-- progressive-agent:task-one:pr -->'}]);});await p.backfill('github','token',{binding:{repo:'owner/repo'}},{id:'task-one',original:{id:'1'},result:{pr:'pr',tests:'test',commit:'sha',runUrl:'run'}});assert.equal(writes,0);});
test('expiring OAuth credentials refresh and persist the replacement token',async()=>{const f=fixture();const c=await f.authorize('linear');await f.p.store.run('UPDATE pa_connections SET credential=? WHERE id=?',await seal(f.env.PA_ENCRYPTION_KEY,{access_token:'expired',refresh_token:'refresh',expiresAt:1},c.id),c.id);const expired=await f.p.store.own('connections',c.id,owner);assert.equal(await f.p.access(expired),'oauth-access');const fresh=await f.p.store.own('connections',c.id,owner);assert.ok((await open(f.env.PA_ENCRYPTION_KEY,fresh.credential,c.id)).expiresAt>Date.now());});
test('project runner service is scoped and can ingest meetings without a browser identity',async()=>{const f=fixture();const {project,meeting}=await f.setup();project.binding.runnerTokenHash=await hash('project-token');await f.p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(project.binding),project.id);const request=(token,projectId=project.id)=>new Request('https://example.test/api/runner/meeting',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({projectId,sourceOpenId:meeting.identity.id,externalId:'cloud-meeting',title:'Focus Board weekly',transcript:'Focus Board should add title search.'})});const options={providers:f.providers,fetcher:f.fetcher};assert.equal((await route(request('wrong'),f.env,'',options)).status,401);const ok=await route(request('project-token'),f.env,'',options);assert.equal(ok.status,200);assert.equal((await ok.json()).taskIds.length,1);assert.equal((await route(request('project-token','other-project'),f.env,'',options)).status,401);});
test('GitHub empty 201 and 204 responses support secret installation and workflow dispatch',async()=>{const provider=new Providers(async url=>new Response(null,{status:url.endsWith('/secret')?201:204}));assert.deepEqual(await provider.gh('token','/secret',{value:'sealed'},'PUT'),{});assert.deepEqual(await provider.gh('token','/dispatches',{ref:'main'}),{});});
test('editing project aliases preserves installed runner identity and credential',async()=>{const f=fixture();const {project}=await f.setup();project.binding.runnerTokenHash='runner-token-hash';project.binding.runnerCredential='encrypted-runner-credential';await f.p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(project.binding),project.id);await f.p.bind(owner,project.id,{...project.binding,aliases:['Board Alias']});const saved=await f.p.store.own('projects',project.id,owner);assert.equal(saved.binding.runnerReady,true);assert.equal(saved.binding.workflowSha,'workflow-sha');assert.equal(saved.binding.runnerSha,'runner-sha');assert.equal(saved.binding.runnerTokenHash,'runner-token-hash');assert.equal(saved.binding.runnerCredential,'encrypted-runner-credential');});
test('invalid extraction evidence is retriable rather than silently dropping a task',async()=>{const f=fixture();const p=new Platform(f.env,{fetcher:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({actions:[{title:'Task',goal:'Implement feature',acceptance:['Test'],evidence:'invented quote'}]})}}]})});await assert.rejects(()=>p.extract('Actual transcript with a real requirement.'),{code:'extraction_evidence_invalid'});});


test('Feishu search display markup is decoded before titles are normalized',async()=>{
 const p=new Providers(async()=>Response.json({code:0,data:{items:[{token:'MeetingToken00001',display_info:'Sprint Desk &lt;b&gt;关键词&lt;/b&gt;：search',meta_data:{app_link:'https://example.feishu.cn/minutes/MeetingToken00001'}}],has_more:false}}));
 const page=await p.meetings('token','owner',{since:0,until:1000});assert.equal(page.items[0].title,'Sprint Desk');assert.equal(page.items[0].externalId,'MeetingToken00001');
});
test('explicit retry after correcting configuration reuses task, issue, session and patch, excluding the failed run',async()=>{
 const f=fixture(),t=await queued(f);t.project.binding.runnerReady=true;await f.p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(t.project.binding),t.project.id);let row=await f.p.store.own('tasks',t.id,owner);await f.p.store.saveTask(row,'failed');f.setRunState({status:'completed',conclusion:'failure'});
 await f.p.approve(owner,t.id,{restart:true});row=await f.p.store.own('tasks',t.id,owner);assert.equal(row.status,'queued');assert.equal(row.payload.session.id,'session-1');assert.equal(row.payload.patchChecksum,patchChecksum);assert.equal(row.payload.githubRunId,undefined);assert.equal(row.payload.rejectedRuns[0].id,'9');
 f.setRuns([{id:9,display_title:'PA '+t.id}]);await f.ex.tick();assert.equal(f.counters.issues,1);assert.equal(f.counters.dispatch,2);await assert.rejects(()=>f.ex.claim(t.project,{taskId:t.id,runId:'9'}),{code:'task_claimed_by_another_run'});await f.ex.claim(t.project,{taskId:t.id,runId:'10'});f.env.DB.raw.close();
});
test('configuration retry cannot replace an active cloud run',async()=>{
 const f=fixture(),t=await queued(f),row=await f.p.store.own('tasks',t.id,owner);await f.p.store.saveTask(row,'failed');f.setRunState({status:'in_progress',conclusion:null});await assert.rejects(()=>f.p.approve(owner,t.id,{restart:true}),{code:'run_not_failed'});assert.equal((await f.p.store.own('tasks',t.id,owner)).payload.githubRunId,'9');f.env.DB.raw.close();
});
test('explicit acceptance changes invalidate the prior code review before a retry',async()=>{
 const f=fixture(),t=await queued(f),row=await f.p.store.own('tasks',t.id,owner);row.payload.fidelityVersion=1;row.payload.fidelityReview={approved:true,patchChecksum,filesDigest:'old'};await f.p.store.saveTask(row,'failed');
 f.setRunState({status:'completed',conclusion:'failure'});await f.p.approve(owner,t.id,{restart:true,acceptance:['Only the newly confirmed behavior']});const after=await f.p.store.own('tasks',t.id,owner);assert.equal(after.payload.fidelityReview,undefined);assert.equal(after.payload.sourceEvidence[0].kind,'user_confirmation');f.env.DB.raw.close();
});
