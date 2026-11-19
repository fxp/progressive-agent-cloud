import test from 'node:test';
import assert from 'node:assert/strict';
import {groundedActions,extractGrounded,noteSources,reviewChange} from '../fidelity.mjs';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {route} from '../http.mjs';
import {seal} from '../security.mjs';
import {sessionCookie} from '../auth.mjs';

const todo='在 Relay Desk 实现优先级筛选，测试通过后创建草稿 PR。';
const condition='仅提供全部和高优先级两个选项，不增加普通优先级。默认显示三条，高优先级显示一条，切回全部恢复三条。';
const input={title:'Relay Desk meeting',transcript:todo,sourceTodos:[{id:'t1',content:todo}],sourceNotes:[{id:'chapter:0',kind:'chapter',title:'Relay Desk 验收',text:condition},{id:'chapter:1',kind:'chapter',title:'Other Project',text:'另一个项目要实现排序和导出功能。'}]};
const proposal=()=>({actions:[{todoIds:['t1'],project:'Relay Desk',goal:'Invent an export feature',criteria:[{source:'chapter:0',quote:condition}]}]});
function platform(responses){const requests=[];return {now:()=>100,agentKey:async user=>{assert.equal(user,'owner');return 'owner-model-key';},requests,fetch:async(url,options)=>{const body=JSON.parse(options.body);assert.equal(options.headers.authorization,'Bearer owner-model-key');requests.push(body);const next=responses.shift();if(next instanceof Error)throw next;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(next)}}]});}};}

test('omitted closed-set constraints are copied verbatim from notes; model-invented goals cannot reach coding',()=>{
 const [a]=groundedActions(input,proposal());assert.deepEqual(a.acceptance,[condition]);assert.equal(a.goal,todo);assert.equal(a.title,todo);assert.equal(a.goal.includes('export'),false);assert.equal(a.sourceEvidence[0].sourceId,'chapter:0');
});
test('a nonexistent quotation or a task invented from notes is rejected',()=>{
 const forged=proposal();forged.actions[0].criteria[0].quote='允许增加普通优先级。';assert.throws(()=>groundedActions(input,forged),{code:'extraction_evidence_invalid'});
 const orphan=proposal();orphan.actions[0].todoIds=['invented'];assert.throws(()=>groundedActions(input,orphan),{code:'extraction_evidence_invalid'});
});
test('one todo cannot generate multiple tasks and another todo cannot supply unrelated evidence',()=>{
 const repeated=proposal();repeated.actions.push(structuredClone(repeated.actions[0]));assert.throws(()=>groundedActions(input,repeated),{code:'extraction_evidence_invalid'});
 const extended={...input,sourceTodos:[...input.sourceTodos,{id:'t2',content:'Another unrelated feature needs export.'}]};const result=proposal();result.actions[0].criteria=[{source:'todo:t2',quote:extended.sourceTodos[1].content}];assert.throws(()=>groundedActions(extended,result),{code:'extraction_evidence_invalid'});
});
test('the independent grounding review blocks unrelated, incomplete and contradictory criteria',async()=>{
 const p=platform([proposal(),{groups:[{indices:[0],approved:false,reason:'条件涉及其他功能或遗漏排除项'}]}]);const [a]=await extractGrounded(p,'owner',input);assert.equal(a.requiresClarification,true);assert.match(a.clarificationReason,/遗漏/);assert.equal(p.requests.length,2);
});
test('missing review entries or uncertainty cannot authorize automatic execution',async()=>{
 for(const uncertain of [false,true]){const r=proposal();r.actions[0].uncertain=uncertain;const p=platform([r,uncertain?{groups:[{indices:[0],approved:true}]}:{groups:[]}]);assert.equal((await extractGrounded(p,'owner',input))[0].requiresClarification,true);}
});
test('complete same-feature evidence passes both grounding stages without forwarding a transcript',async()=>{
 const p=platform([proposal(),{groups:[{indices:[0],approved:true}]}]);const [a]=await extractGrounded(p,'owner',input);assert.equal(a.requiresClarification,false);assert.deepEqual(a.acceptance,[condition]);assert.equal(p.requests[1].messages[0].content.startsWith('PA_FIDELITY_grounding'),true);
 const notes=noteSources({transcript:'PRIVATE TRANSCRIPT',summary:condition,minute_chapters:[{title:'验收',summary_content:condition}]});assert.equal(notes.length,2);assert.equal(JSON.stringify(notes).includes('PRIVATE TRANSCRIPT'),false);
});
test('development and merge-stage todos for the same feature become one executable task',async()=>{
 const extended={...input,sourceTodos:[...input.sourceTodos,{id:'t2',content:'Relay Desk 完成验收后合并这个筛选功能。'}]};const result=proposal();result.actions.push({todoIds:['t2'],project:'Relay Desk',criteria:[{source:'todo:t2',quote:extended.sourceTodos[1].content}]});
 const p=platform([result,{groups:[{indices:[0,1],approved:true}]}]);const actions=await extractGrounded(p,'owner',extended);assert.equal(actions.length,1);assert.deepEqual(actions[0].actionTodoIds,['t1','t2']);assert.equal(actions[0].requiresClarification,false);assert.ok(actions[0].acceptance.includes(condition));
});
test('overlapping or omitted review groups cannot authorize code dispatch',async()=>{
 for(const groups of [[{indices:[0,0],approved:true}],[]]){const p=platform([proposal(),{groups}]);assert.equal((await extractGrounded(p,'owner',input))[0].requiresClarification,true);}
});
test('evidence preview requires the owning signed workspace and never returns credentials',async()=>{
 const env={DB:database(),PA_AUTH_MODE:'github',PA_SIGNUP_MODE:'open',PA_ORIGIN:'https://example.test',PA_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),PA_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64')};const p=new Platform(env);await p.register('A','A');await p.register('B','B');
 await p.store.connect({id:'source-A',user:'A',provider:'feishu',kind:'meeting',identity:{meetingContent:'todos'},credential:await seal(env.PA_ENCRYPTION_KEY,{access_token:'PRIVATE_OWNER_TOKEN'},'source-A')});
 let calls=0;const options={providers:{todoEvidence:async token=>{calls++;assert.equal(token,'PRIVATE_OWNER_TOKEN');return {sourceNotes:input.sourceNotes};}}};
 const url=env.PA_ORIGIN+'/api/meetings/MeetingToken00001/evidence';assert.equal((await route(new Request(url),env,'',options)).status,401);
 for(const user of ['B','A']){const cookie=(await sessionCookie({user,login:user},{secret:env.PA_SESSION_KEY})).split(';')[0];const r=await route(new Request(url,{headers:{cookie}}),env,'',options);assert.equal(r.status,user==='A'?200:409);assert.equal((await r.text()).includes('PRIVATE_OWNER_TOKEN'),false);}
 assert.equal(calls,1);env.DB.raw.close();
});
test('a code review rejecting an extra option fails closed even if implementation tests pass',async()=>{
 const p=platform([{approved:false,violations:['代码增加了普通优先级选项，违反只允许两个选项。']}]);const [task]=groundedActions(input,proposal());task.patchChecksum='abc';const files=[{path:'index.html',content:Buffer.from('<select><option>全部</option><option>高</option><option>普通</option></select>').toString('base64')}];const result=await reviewChange(p,'owner',task,files);assert.equal(result.approved,false);assert.match(result.violations[0],/普通/);assert.equal(p.requests[0].messages[0].content.startsWith('PA_FIDELITY_code'),true);
});
test('code review is reused only for identical files and patch; malformed approvals cannot publish',async()=>{
 const p=platform([{approved:true,violations:[]},{approved:false,violations:['changed code']}]);const [task]=groundedActions(input,proposal());task.patchChecksum='abc';const files=[{path:'a.js',content:Buffer.from('exact code').toString('base64')}];task.fidelityReview=await reviewChange(p,'owner',task,files);assert.equal((await reviewChange(p,'owner',task,files)).approved,true);assert.equal(p.requests.length,1);assert.equal((await reviewChange(p,'owner',task,[{...files[0],content:Buffer.from('different').toString('base64')}])).approved,false);
 const invalid=platform([{approved:true}]);await assert.rejects(()=>reviewChange(invalid,'owner',task,files.map(f=>({...f,path:'new.js'}))),{code:'requirement_review_invalid'});
});
test('omitted or wholly ambiguous TODOs remain visible and cannot auto-execute',async()=>{
 const unclear={id:'t2',content:'Relay Desk 的提醒要更智能，尚未确认触发条件和通知方式。'};
 for(const result of [proposal(),{actions:[]}]){
  const p=platform(result.actions.length?[result,{groups:[{indices:[0],approved:true}]}]:[result]);
  const actions=await extractGrounded(p,'owner',{...input,sourceTodos:[...input.sourceTodos,unclear]});
  const pending=actions.find(a=>a.actionTodoIds.includes('t2'));assert.equal(pending.requiresClarification,true);assert.deepEqual(pending.acceptance,[]);assert.match(pending.clarificationReason,/预期行为/);
 }
});
