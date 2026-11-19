import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectorRegistry,contracts} from '../connectors/registry.mjs';
import {createRegistry} from '../connectors/builtins.mjs';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {Execution} from '../execution.mjs';
import {route} from '../http.mjs';
import {seal} from '../security.mjs';

const manifest={id:'extension-suite',apiVersion:1,kind:'agent',name:'Example extension',roles:Object.keys(contracts),auth:'api_key',capabilities:['execute','backfill']};
const texts=['Plugin Board 实现只读统计，不增加筛选或导出。','Plugin Board 提醒更智能，触发条件与渠道未确认。'];
const input={externalId:'extension-meeting',title:'Plugin Board',url:'https://example.test/meetings/ext',transcript:texts.join('\n'),sourceKind:'meeting_todos',sourceTodos:texts.map((content,i)=>({id:'t'+i,content})),sourceNotes:[]};
function extension(counters){return {manifest,
 meeting:{discover:async({platform:p},c)=>p.ingest(c,input),read:async()=>input},
 project:{list:async()=>[{externalId:'board',name:'Plugin Board',url:'https://example.test/project'}],createRequirement:async()=>{counters.issue++;return {id:'original',url:'https://example.test/issue'};}},
 agent:{validate:async()=>({apiKey:'private-extension-key'}),credential:async()=>({apiKey:'private-extension-key'}),execution:()=>({id:manifest.id,runtime:'custom'}),completeJSON:async(_,__,request)=>{
  if(request.system.startsWith('PA_FIDELITY_extract'))return {actions:texts.map((text,i)=>({todoIds:['t'+i],project:'Plugin Board',criteria:[{source:'todo:t'+i,quote:text}],uncertain:i===1}))};
  if(request.system.startsWith('PA_FIDELITY_grounding'))return {groups:[{indices:[0],approved:true},{indices:[1],approved:false,reason:'请确认提醒条件和渠道'}]};
  return {approved:true,violations:[]};
 }},
 repository:{repository:async(_,__,repo)=>({name:repo,defaultBranch:'main'}),repositories:async()=>[],install:async()=>{},dispatch:async()=>{counters.dispatch++;},runs:async()=>[],run:async()=>({status:'completed',conclusion:'success'}),rerun:async()=>{},verify:async()=>({html_url:'https://example.test/run'}),baseline:async()=>[],publish:async()=>{counters.publish++;return {pr:'https://example.test/pr',commit:'head',tests:'node --test',runUrl:'https://example.test/run'};},verification:async()=>({verified:true}),refreshCredentials:async()=>{}},
 delivery:{backfill:async()=>{counters.delivery++;}},
 actions:{describe:async({user})=>({user,roles:manifest.roles})},
};}

test('registration validates versions and all five contracts, prevents duplicate IDs and scopes capabilities',()=>{
 const r=new ConnectorRegistry(),p=extension({});r.register(p);assert.equal(r.list('meeting').length,1);assert.equal(r.get(p.manifest.id,'repository'),p.repository);assert.throws(()=>r.register(p),{code:'connector_already_registered'});
 assert.throws(()=>new ConnectorRegistry().register({...p,manifest:{...manifest,apiVersion:2}}),{code:'invalid_connector_manifest'});
 assert.throws(()=>new ConnectorRegistry().register({...p,repository:{}}),{code:'connector_contract_missing'});assert.throws(()=>r.get('absent','agent'),{code:'unsupported_connector_agent'});
 const core=createRegistry();assert.deepEqual(core.list('agent').map(m=>m.id),['bigmodel','codex','claude-code']);assert.equal(core.list('repository').some(m=>m.id==='github'),true);assert.throws(()=>core.get('feishu','repository'),{code:'unsupported_connector_repository'});
});
test('a new plugin runs source → project → Agent → repository → delivery without built-in provider branches, pausing uncertainty and replaying twice',async()=>{
 const counters={issue:0,dispatch:0,publish:0,delivery:0},registry=createRegistry([extension(counters)]),env={DB:database(),PA_ORIGIN:'https://example.test',PA_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64')};
 const p=new Platform(env,{registry,providers:new Proxy({},{get:()=>()=>assert.fail('A custom plugin must not fall back to a built-in provider')})});
 await p.register('owner','owner');const c=await p.store.connect({id:'extension-connection',user:'owner',provider:manifest.id,kind:'agent',identity:{id:'owner'},credential:await seal(env.PA_ENCRYPTION_KEY,{access_token:'private-owner-token'},'extension-connection')});
 await p.sync('owner',c.id);const project=(await p.store.all('SELECT * FROM pa_projects'))[0];await p.bind('owner',project.id,{repository:manifest.id,repo:'owner/repo',repositoryConnectionId:c.id,agent:manifest.id,allowedPaths:['app.js'],validation:['node --test'],automatic:true});const ready=await p.store.own('projects',project.id,'owner');ready.binding.runnerReady=true;await p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(ready.binding),project.id);
 const result=await registry.get(manifest.id,'meeting').discover({platform:p},c);assert.equal(result.taskIds.length,2);const ex=new Execution(p,'');await ex.tick(undefined,'owner');const rows=await p.store.all('SELECT * FROM pa_tasks');const clear=rows.find(r=>r.payload.actionTodoIds.includes('t0')),unclear=rows.find(r=>r.payload.actionTodoIds.includes('t1'));assert.equal(unclear.status,'needs_info');assert.equal(unclear.payload.original,undefined);
 const claimed=await ex.claim(ready,{taskId:clear.id,runId:'9'});assert.equal(claimed.execution.id,manifest.id);const base='a'.repeat(40),patchChecksum='b'.repeat(64);await ex.checkpoint(ready,{taskId:clear.id,runId:'9',session:{id:'custom-session',base},patchChecksum});const complete={taskId:clear.id,runId:'9',base,patchChecksum,files:[{path:'app.js',mode:'100644',content:Buffer.from('const count=0;').toString('base64')}]};await ex.complete(ready,complete);
 for(let n=0;n<2;n++){assert.deepEqual((await p.ingest(c,input)).taskIds,result.taskIds);await ex.tick(undefined,'owner');await ex.complete(ready,complete);}assert.deepEqual(counters,{issue:1,dispatch:1,publish:1,delivery:1});assert.deepEqual(await ex.verification('owner',clear.id),{verified:true});env.DB.raw.close();
});
test('plugin actions share the authenticated owner and origin boundary',async()=>{
 const registry=createRegistry([extension({})]),env={DB:database(),PA_ORIGIN:'https://example.test',PA_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64')},url=env.PA_ORIGIN+'/api/connectors/'+manifest.id+'/actions/describe';
 for(const [origin,status]of [['https://evil.test',403],[env.PA_ORIGIN,200]]){const r=await route(new Request(url,{method:'POST',headers:{origin,'oai-authenticated-user-id':'owner','content-type':'application/json'},body:'{}'}),env,'',{registry});assert.equal(r.status,status);if(status===200)assert.equal((await r.json()).user,'owner');}env.DB.raw.close();
});
for(const provider of ['codex','claude-code'])test(provider+' settings validate the gateway before saving encrypted owner credentials and never expose them in state',async()=>{
 const env={DB:database(),PA_ORIGIN:'https://example.test',PA_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64')};const requests=[],p=new Platform(env,{fetcher:async(url,options)=>{requests.push({url,options});assert.equal(options.redirect,'manual');return Response.json({});}});
 await p.saveCodingAgent('A',provider,{apiKey:'private-gateway-key-A',baseUrl:'https://open.bigmodel.cn/api/'+(provider==='codex'?'v1':'anthropic'),protocol:provider==='codex'?'responses':'anthropic',model:'glm-5.3'});const state=await p.state('A');assert.equal(state.connectors.find(c=>c.id===provider).identity.model,'glm-5.3');assert.equal(JSON.stringify(state).includes('private-gateway-key-A'),false);assert.equal((await p.state('B')).connectors.find(c=>c.id===provider).status,'disconnected');assert.equal(requests.length,1);
 await assert.rejects(()=>p.saveCodingAgent('B',provider,{apiKey:'private-key-B',baseUrl:'http://127.0.0.1:3425',model:'glm-5.3'}),{code:'invalid_agent_endpoint'});assert.equal(await p.store.connection('B',provider),null);env.DB.raw.close();
});

for(const provider of ['codex','claude-code'])test(provider+' can reason without any BigModel connection and CLI intents require reconciliation',async()=>{
 const env={DB:database(),PA_ORIGIN:'https://example.test',PA_ENCRYPTION_KEY:Buffer.alloc(32,2).toString('base64')};
 const p=new Platform(env,{fetcher:async(url)=>Response.json(url.endsWith('/responses')?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"approved":true}'}]}]}:{stop_reason:'end_turn',content:[{type:'text',text:'{"approved":true}'}]})});
 await p.saveCodingAgent('A',provider,{apiKey:'private-gateway-key',baseUrl:'https://open.bigmodel.cn/api/'+(provider==='codex'?'v1':'anthropic'),model:'glm-5.3'});
 assert.deepEqual(await p.completeJSON('A',{system:'JSON only',content:'Review',maxTokens:100}),{approved:true});
 await p.register('A','A');const c=await p.store.connection('A',provider);await p.store.putProject('A',c.id,{id:'project',externalId:'p',name:'Test',url:'https://example.test/project'});
 const binding={agent:provider,runnerReady:true,repo:'A/repo',repository:'github'};await p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(binding),'project');const project=await p.store.own('projects','project','A');
 await p.store.putTask({id:'task',userId:'A',projectId:'project',meetingKey:'meeting',githubRunId:'9',acceptance:['Confirmed requirement']},'running');const ex=new Execution(p,'');
 await ex.checkpoint(project,{taskId:'task',runId:'9',cliIntent:{revision:0}});await assert.rejects(()=>ex.checkpoint(project,{taskId:'task',runId:'9',cliIntent:{revision:0}}),{code:'cli_intent_conflict'});
 await assert.rejects(()=>ex.checkpoint(project,{taskId:'task',runId:'9',cliArtifact:{revision:0,executor:provider,patch:Buffer.from('patch').toString('base64'),checksum:'a'.repeat(64)},patchChecksum:'a'.repeat(64)}),{code:'invalid_cli_artifact'});
 const row=await p.store.own('tasks','task','A');await p.store.saveTask(row,'failed');await assert.rejects(()=>p.approve('A','task',{}),{code:'cli_intent_requires_explicit_restart'});
 const repo=p.registry.get('github','repository');const old=repo.run;repo.run=async()=>({status:'completed',conclusion:'failure'});
 try{await p.approve('A','task',{restart:true});const reset=await p.store.own('tasks','task','A');assert.equal(reset.status,'queued');assert.equal(reset.payload.cliIntent,undefined);assert.equal(reset.payload.cliIntentHistory[0].runId,'9');assert.equal(reset.payload.rejectedRuns[0].id,'9');reset.payload.cliArtifact={history:'private-session-history'};await p.store.saveTask(reset);assert.equal(JSON.stringify(await p.state('A')).includes('private-session-history'),false);}finally{repo.run=old;env.DB.raw.close();}
});
