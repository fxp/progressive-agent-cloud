import test from 'node:test';
import assert from 'node:assert/strict';
import {Providers} from '../providers.mjs';
import {Platform} from '../service.mjs';
import {database} from '../../scripts/local-db.mjs';
import {scanSource} from '../sources.mjs';
import {seal,Fault} from '../security.mjs';

const minute='MeetingToken00001',content='Sprint Desk should add a completed filter. Show all, pending and completed tasks.';
function artifacts(todos){return {code:0,data:{summary:'UNUSED_SUMMARY',transcript:'DO_NOT_PROCESS_TRANSCRIPT',minute_todos:todos}};}
test('todo evidence retains unfinished tasks and note context while excluding the transcript',async()=>{
 const provider=new Providers(async(url,options)=>{
  assert.equal(url,'https://open.feishu.cn/open-apis/minutes/v1/minutes/'+minute+'/artifacts');assert.equal(options.method,'GET');
  return Response.json(artifacts([{todo_id:'todo-1',content,assignees:['Owner'],is_done:false},{todo_id:'todo-2',content:'Already completed',is_done:true}]));
 });
 const evidence=await provider.todoEvidence('own-user-token',minute);
 assert.deepEqual(evidence,{transcript:content,sourceKind:'meeting_todos',sourceTodoIds:['todo-1'],sourceTodos:[{id:'todo-1',content}],sourceNotes:[{id:'summary',kind:'summary',text:'UNUSED_SUMMARY'}],empty:false});
 assert.equal(JSON.stringify(evidence).includes('DO_NOT_PROCESS'),false);assert.equal(evidence.sourceNotes[0].text,'UNUSED_SUMMARY');
});
test('not-generated todos remain retryable, and finished todos do not become new tasks',async()=>{
 const missing=new Providers(async()=>Response.json(artifacts(undefined)));
 await assert.rejects(()=>missing.todoEvidence('token',minute),{code:'meeting_todos_not_ready'});
 const finished=new Providers(async()=>Response.json(artifacts([{todo_id:'done',content:'Finished work',is_done:true}])));
 assert.equal((await finished.todoEvidence('token',minute)).empty,true);
});
test('cloud todo discovery never exports a transcript and does not create another task on two later rounds',async()=>{
 const env={DB:database(),PA_ENCRYPTION_KEY:Buffer.alloc(32,4).toString('base64')};let modelCalls=0,ready=false;
 const providers={meetings:async()=>({items:[{externalId:minute,title:'Sprint Desk review',url:'https://example.feishu.cn/minutes/'+minute}],nextPage:null}),transcript:()=>assert.fail('Todo mode must not export transcripts'),todoEvidence:async()=>{if(!ready)throw new Fault(409,'meeting_todos_not_ready');return {transcript:content,sourceKind:'meeting_todos',sourceTodoIds:['todo-1']};}};
 const p=new Platform(env,{providers,now:()=>1795080000000,fetcher:async(url,options)=>{const request=JSON.parse(options.body);const extract=request.messages[0].content.startsWith('PA_FIDELITY_extract');if(extract)modelCalls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(extract?{actions:[{todoIds:['todo:0'],project:'Sprint Desk',criteria:[{source:'todo:todo:0',quote:content}]}]}:{groups:[{indices:[0],approved:true}]})}}]});}});await p.register('A','A');p.agentKey=async()=> 'own-model-key';
 const connection=await p.store.connect({id:'source-A',user:'A',provider:'feishu',kind:'meeting',identity:{id:'ou_A',meetingContent:'todos'},credential:await seal(env.PA_ENCRYPTION_KEY,{access_token:'own-user-token'},'source-A')});
 assert.equal((await scanSource(p,connection)).ingested,0);assert.equal((await p.store.all('SELECT * FROM pa_receipts')).length,0);
 ready=true;assert.equal((await scanSource(p,connection)).ingested,1);
 for(let round=0;round<2;round++)assert.equal((await scanSource(p,connection)).ingested,0);
 const tasks=await p.store.all('SELECT * FROM pa_tasks');assert.equal(tasks.length,1);assert.equal(modelCalls,1);assert.equal(tasks[0].payload.sourceKind,'meeting_todos');assert.deepEqual(tasks[0].payload.sourceTodoIds,['todo-1']);env.DB.raw.close();
});
