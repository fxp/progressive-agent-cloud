import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Exercise the shipped script and its click handlers without external accounts.
async function fixture({setupState='completed',connected=true}={}){
 const elements=new Map(),calls=[],timers=new Map();let timer=0;
 function element(id){
  const handlers=new Map();let html='',children=[];
  const node={id,open:false,hidden:false,textContent:'',isConnected:true,addEventListener(type,fn){handlers.set(type,fn);},fire(type,event={}){return handlers.get(type)?.({target:node,...event});},showModal(){node.open=true;},close(){node.open=false;node.fire('close');},replaceChildren(){node.innerHTML='';},append(){},classList:{toggle(){}}};
  Object.defineProperty(node,'innerHTML',{get:()=>html,set(value){for(const id of children)elements.delete('#'+id);html=value;children=[...value.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);for(const child of children)elements.set('#'+child,element(child));}});
  return node;
 }
 for(const id of ['notice','modal','modal-title','modal-body','close-modal','project-count','task-count','scheduler','content','beta-nav','page-title','page-subtitle','onboarding','account-label','logout','check-now','refresh'])elements.set('#'+id,element(id));
 const state={account:{login:'Test'},projects:[],tasks:[],scheduler:true,connectors:[{id:'feishu',connectionId:'source',kind:'meeting',auth:'oauth',status:connected?'connected':'disconnected',name:'飞书妙记',identity:{onboarding:'scan'},capabilities:[]}]};
 let setup={id:'setup-test',state:setupState,readingMode:'todos',nextPollAt:Date.now()+5000};
 let deferState;
 const context=createContext({URLSearchParams,AbortSignal,console,location:{hash:'#connectors',search:''},document:{querySelector:s=>elements.get(s)??null,querySelectorAll:()=>[],activeElement:null},window:{addEventListener(){}},setTimeout(fn){timers.set(++timer,fn);return timer;},clearTimeout(id){timers.delete(id);},setInterval(){},fetch:async path=>{
  calls.push(path);
  if(path==='/api/state'){if(deferState)await deferState;return Response.json(state);}
  if(path.endsWith('/start')||path.endsWith('/poll'))return Response.json(setup);
  if(path.endsWith('/authorize')){setup={...setup,state:'user_authorizing'};return Response.json(setup);}
  if(path.endsWith('/sync')||path==='/api/check')return Response.json({queued:false,reason:'agent_not_connected'});
  throw Error('Unexpected request '+path);
 }});
 runInContext(readFileSync(new URL('../../dist/app/workbench.js',import.meta.url),'utf8'),context);
 await new Promise(resolve=>setImmediate(resolve));
 return {calls,timers,e:id=>elements.get('#'+id),run:code=>runInContext(code,context),setSetup:value=>setup={...setup,...value},deferState:promise=>deferState=promise};
}

test('reopening a completed Feishu setup shows saved authorization without starting a new grant',async()=>{
 const f=await fixture();await f.run('bootstrapFeishu()');
 assert.match(f.e('modal-body').innerHTML,/飞书已连接/);assert.ok(f.e('bootstrap-done'));assert.equal(f.timers.size,0);
 assert.equal(f.calls.filter(p=>p.endsWith('/authorize')).length,0);
 f.e('bootstrap-done').fire('click');await f.run('bootstrapFeishu()');
 assert.match(f.e('modal-body').innerHTML,/无需再次扫码/);assert.equal(f.calls.filter(p=>p.endsWith('/authorize')).length,0);
 await f.e('bootstrap-authorize').fire('click');assert.equal(f.calls.filter(p=>p.endsWith('/authorize')).length,1);assert.equal(f.timers.size,1);
});

test('a completed application does not claim a disconnected grant is connected',async()=>{
 const f=await fixture({connected:false});await f.run('bootstrapFeishu()');
 assert.match(f.e('modal-body').innerHTML,/当前连接需要重新授权/);assert.equal(f.e('bootstrap-done'),undefined);assert.ok(f.e('bootstrap-authorize'));
});

test('an already connected user can leave a pending replacement grant and continue onboarding',async()=>{
 const f=await fixture({setupState:'user_authorizing'});await f.run('bootstrapFeishu()');
 assert.match(f.e('modal-body').innerHTML,/正在等待本次妙记读取授权确认/);assert.ok(f.e('bootstrap-existing'));
 f.e('bootstrap-existing').fire('click');assert.equal(f.e('modal').open,false);assert.equal(f.timers.size,0);
 assert.equal(f.calls.filter(p=>p.endsWith('/authorize')).length,0);
});

test('meeting check click reports missing Agent instead of a false queued success',async()=>{
 const f=await fixture();const button={dataset:{sync:'source'},closest:()=>null,textContent:'检查会议',isConnected:true};
 await f.e('content').fire('click',{target:{closest:()=>button}});
 assert.match(f.e('notice').textContent,/请先连接自己的 Agent/);assert.doesNotMatch(f.e('notice').textContent,/已提交/);
 assert.match(f.e('content').innerHTML,/待连接 Agent 后检查/);
});

test('a closed authorization modal ignores a late completion response',async()=>{
 const f=await fixture();let resume;f.deferState(new Promise(resolve=>resume=resolve));
 const opening=f.run('bootstrapFeishu()');await new Promise(resolve=>setImmediate(resolve));
 f.e('modal').close();resume();await opening;
 assert.equal(f.e('modal').open,false);assert.equal(f.e('modal-body').innerHTML,'');assert.equal(f.timers.size,0);
});
