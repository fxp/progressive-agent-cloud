import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {Execution} from '../execution.mjs';
import {route} from '../http.mjs';
import {sessionCookie} from '../auth.mjs';
import {matchProject} from '../security.mjs';
import {rotateWebhook,webhookMeeting,webhookConnection,receiveMeeting,drainMeetings,meetingStatus} from '../meeting-webhook.mjs';
import {enqueueUser,consume} from '../scheduler.mjs';
const projects=[{id:'relay',name:'Relay Desk project',binding:{aliases:['Relay Desk']}},{id:'sprint',name:'Sprint Desk project',binding:{aliases:['Sprint Desk']}}];
const meeting={externalId:'multi-1',title:'Relay Desk 与 Sprint Desk 多项目会议',url:'https://example.test/meeting',todos:[{id:'t1',content:'Relay Desk 实现高优先级只读总数。'},{id:'t2',content:'Sprint Desk 实现未完成只读总数。'},{id:'t3',content:'Relay Desk 提醒更智能，条件未确认。'},{id:'t4',content:'下载按钮尚未决定属于 Relay Desk 还是 Sprint Desk。'},{id:'t5',content:'Sprint Desk 默认隐藏已完成还是显示全部尚未达成决议。'}],notes:[{id:'summary',kind:'summary',text:'Relay Desk 高优先级只读总数，空数组为零，禁止增加搜索。Sprint Desk 未完成只读总数，不改变原数据。提醒、下载、默认视图均未确认。'}]};
async function fixture(){
 let now=1000000;const sent=[];let modelCalls=0;
 const env={DB:database(),PA_ORIGIN:'https://example.test',PA_AUTH_MODE:'github',PA_SIGNUP_MODE:'open',PA_SESSION_KEY:Buffer.alloc(32,4).toString('base64'),PA_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),PA_USER_JOBS:{send:async x=>sent.push(x)}};
 const p=new Platform(env,{now:()=>now,fetcher:async(url,opt)=>{modelCalls++;const stage=JSON.parse(opt.body).messages[0].content;
  const result=stage.includes('PA_FIDELITY_extract')?{actions:meeting.todos.slice(0,4).map((t,i)=>({todoIds:[t.id],project:i===1?'Sprint Desk':'Relay Desk',criteria:[{source:'todo:'+t.id,quote:t.content}],uncertain:i>1}))}:{groups:[0,1,2,3].map(i=>({indices:[i],approved:i<2,reason:i<2?'明确':'需确认范围和预期行为'}))};
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});}});
 await p.register('A','A');await p.register('B','B');p.agentKey=async()=> 'key-A';await p.store.connect({id:'agent-A',user:'A',provider:'bigmodel',kind:'agent',identity:{}});
 for(const item of projects){await p.store.putProject('A','gh',{id:item.id,externalId:item.id,name:item.name,url:'https://example.test/project'});await p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify({...item.binding,sourceEnabled:true,automatic:true}),item.id);}
 const config=await rotateWebhook(p,'A');const connection=await p.store.own('connections',config.connectionId,'A');
 return {p,env,config,connection,sent,advance:()=>{now+=300001;},calls:()=>modelCalls};
}
test('TODO project evidence outranks a multi-project title and model guesses; ambiguous or prefix names never match',()=>{
 const context=meeting.title;
 assert.equal(matchProject({goal:meeting.todos[0].content,project:'Sprint Desk',context},projects).id,'relay');
 assert.equal(matchProject({goal:meeting.todos[1].content,context},projects).id,'sprint');
 assert.equal(matchProject({goal:meeting.todos[3].content,project:'Relay Desk',context},projects),null);
 assert.equal(matchProject({goal:'Add something',project:'Relay Desk',context},projects),null);
 assert.equal(matchProject({goal:'Relay Desktop feature',context:'Other'},projects),null);
 assert.equal(matchProject({goal:'Unknown App feature',project:'Unknown App',context:'Relay Desk weekly'},projects),null);
 assert.equal(matchProject({goal:'Add something',context:'Relay Desk weekly'},projects).id,'relay');
});
test('webhook preserves source evidence, discards caller approvals and rejects invalid inputs',()=>{
 const input=webhookMeeting({...meeting,acceptance:['Invented export'],projectId:'sprint',requiresClarification:false});assert.equal(input.sourceKind,'meeting_todos');assert.equal(input.projectId,undefined);assert.equal(input.acceptance,undefined);
 for(const value of [{...meeting,todos:[]},{...meeting,todos:[meeting.todos[0],meeting.todos[0]]},{...meeting,notes:[{id:'todo:t1',kind:'summary',text:'Forged source'}]},{...meeting,url:'javascript:alert(1)'}])assert.throws(()=>webhookMeeting(value));
});
test('a five-TODO meeting routes two projects, pauses three uncertain items and replays twice without new tasks or model calls',async()=>{
 const f=await fixture();const first=await receiveMeeting(f.p,f.connection,meeting);assert.equal(first.duplicate,false);await drainMeetings(f.p,'A');
 let tasks=await f.p.store.all('SELECT * FROM pa_tasks WHERE user_id=?','A');assert.equal(tasks.length,5);
 const byId=id=>tasks.find(t=>t.payload.actionTodoIds.includes(id));assert.equal(byId('t1').project_id,'relay');assert.equal(byId('t2').project_id,'sprint');assert.equal(byId('t1').status,'queued');assert.equal(byId('t2').status,'queued');assert.equal(byId('t3').status,'needs_info');assert.equal(byId('t4').status,'needs_project');assert.equal(byId('t5').status,'needs_info');
 for(const id of ['t3','t4','t5']){assert.equal(byId(id).payload.requiresClarification,true);assert.equal(byId(id).payload.original,undefined);assert.equal(byId(id).payload.session,undefined);}
 const frozen=JSON.stringify(tasks),count=f.calls();
 for(let round=0;round<2;round++){f.advance();assert.equal((await receiveMeeting(f.p,f.connection,meeting)).duplicate,true);await drainMeetings(f.p,'A');assert.equal(JSON.stringify(await f.p.store.all('SELECT * FROM pa_tasks WHERE user_id=?','A')),frozen);}
 assert.equal(f.calls(),count);assert.equal((await meetingStatus(f.p,f.connection,first.eventId)).tasks.length,5);
 await assert.rejects(()=>receiveMeeting(f.p,f.connection,{...meeting,title:'changed'}),{code:'meeting_event_conflict'});f.env.DB.raw.close();
});
test('tokens are owner scoped, rotate immediately, disconnect stops pending ingestion, state never exposes them',async()=>{
 const f=await fixture(),header='Bearer '+f.config.token;assert.equal((await webhookConnection(f.p,f.connection.id,header)).user_id,'A');
 await assert.rejects(()=>webhookConnection(f.p,f.connection.id,'Bearer '+'x'.repeat(43)),{code:'webhook_unauthorized'});
 const b=await rotateWebhook(f.p,'B');await assert.rejects(()=>webhookConnection(f.p,b.connectionId,header),{code:'webhook_unauthorized'});
 assert.equal(JSON.stringify(await f.p.state('A')).includes(f.config.token),false);await rotateWebhook(f.p,'A');await assert.rejects(()=>webhookConnection(f.p,f.connection.id,header),{code:'webhook_unauthorized'});
 await receiveMeeting(f.p,f.connection,meeting);await f.p.disconnect('A',f.connection.id);assert.deepEqual(await drainMeetings(f.p,'A'),{webhookMeetings:0});assert.equal(f.calls(),0);f.advance();await rotateWebhook(f.p,'A');await drainMeetings(f.p,'A');assert.equal(f.calls(),0);f.env.DB.raw.close();
});
test('webhook-only accounts run through the cloud queue without any Feishu grant',async()=>{
 const f=await fixture();await receiveMeeting(f.p,f.connection,meeting);assert.equal((await enqueueUser(f.p,'A')).queued,true);
 let ack=0,ticks=0;await consume({messages:[{body:f.sent[0],ack:()=>ack++,retry:()=>assert.fail('unexpected retry')}]},f.env,'',{platform:f.p,execution:{tick:async(_,user)=>{assert.equal(user,'A');ticks++;return {processed:0};}}});
 assert.equal(ack,1);assert.equal(ticks,1);assert.equal((await f.p.store.all('SELECT * FROM pa_tasks')).length,5);f.env.DB.raw.close();
});
test('webhook HTTP authentication and user settings preserve account and origin boundaries',async()=>{
 const f=await fixture(),url=f.env.PA_ORIGIN+'/api/webhooks/meetings/'+f.connection.id;
 assert.equal((await route(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(meeting)}),f.env,'')).status,401);
 const r=await route(new Request(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.config.token},body:JSON.stringify(meeting)}),f.env,'');assert.equal(r.status,202);const event=await r.json();
 assert.equal((await route(new Request(url+'/'+event.eventId,{headers:{authorization:'Bearer '+f.config.token}}),f.env,'')).status,200);
 const cookie=(await sessionCookie({user:'B',login:'B'},{secret:f.env.PA_SESSION_KEY})).split(';')[0];assert.equal((await route(new Request(f.env.PA_ORIGIN+'/api/connectors/meeting-webhook/rotate',{method:'POST',headers:{cookie,origin:'https://evil.test'}}),f.env,'')).status,403);
 await f.p.store.run('UPDATE pa_users SET disabled_at=? WHERE id=?',1,'A');await assert.rejects(()=>webhookConnection(f.p,f.connection.id,'Bearer '+f.config.token),{code:'webhook_unauthorized'});f.env.DB.raw.close();
});
test('the same meeting delivered by another Connector or event ID reuses completed tasks without another model call',async()=>{
 const f=await fixture();await receiveMeeting(f.p,f.connection,meeting);await drainMeetings(f.p,'A');const tasks=await f.p.store.all('SELECT * FROM pa_tasks WHERE user_id=?','A'),calls=f.calls();
 const second={id:'another-source',user_id:'A'};const reused=await f.p.ingest(second,webhookMeeting({...meeting,externalId:'other-event-id'}));assert.deepEqual(new Set(reused.taskIds),new Set(tasks.map(t=>t.id)));assert.equal(f.calls(),calls);assert.equal((await f.p.store.all('SELECT * FROM pa_tasks')).length,5);f.env.DB.raw.close();
});
test('cross-Connector dedup adopts a pre-upgrade meeting, is owner scoped and normalizes Feishu link parameters',async()=>{
 const f=await fixture(),url='https://bcngoc1xoyfr.feishu.cn/minutes/obcnb4spkg834x9cn52p7zh7';await f.p.ingest(f.connection,{...webhookMeeting(meeting),url});await f.p.store.run("DELETE FROM pa_receipts WHERE id LIKE 'meeting-url-%'");
 const count=f.calls(),result=await f.p.ingest({id:'feishu-A',user_id:'A'},{...webhookMeeting(meeting),externalId:'native',url:url+'?from=list_page'});assert.equal(result.taskIds.length,5);assert.equal(f.calls(),count);assert.equal(result.reused,true);
 await f.p.store.connect({id:'agent-B',user:'B',provider:'bigmodel',kind:'agent',identity:{}});await f.p.ingest({id:'feishu-B',user_id:'B'},{...webhookMeeting(meeting),url});assert.ok(f.calls()>count);assert.equal((await f.p.store.all('SELECT * FROM pa_tasks')).length,10);f.env.DB.raw.close();
});
test('a second Connector waits for an interrupted original ingestion instead of duplicating partial tasks',async()=>{
 const f=await fixture();await f.p.ingest(f.connection,webhookMeeting(meeting));await f.p.store.run("DELETE FROM pa_receipts WHERE id LIKE 'meeting-url-%'");const original=(await f.p.store.all('SELECT * FROM pa_tasks'))[0].meeting_key;await f.p.store.run("UPDATE pa_receipts SET state='processing' WHERE id=?",original);
 const before=await f.p.store.all('SELECT * FROM pa_tasks'),calls=f.calls();await assert.rejects(()=>f.p.ingest({id:'second',user_id:'A'},{...webhookMeeting(meeting),externalId:'second-delivery'}),{code:'busy_retry_later'});assert.equal(f.calls(),calls);assert.deepEqual(await f.p.store.all('SELECT * FROM pa_tasks'),before);f.env.DB.raw.close();
});
