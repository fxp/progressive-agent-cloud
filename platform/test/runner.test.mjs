import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const runner=fileURLToPath(new URL('../runner.mjs',import.meta.url));
test('prepare sends a task in the Managed Agent events envelope and resumes the saved session',()=>{
 const root=mkdtempSync(join(tmpdir(),'pa-prepare-test-')),repo=join(root,'repo'),shim=join(root,'fetch.mjs'),output=join(root,'output');mkdirSync(repo);
 const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 try{
  git(['init','-b','main']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Test']);
  writeFileSync(join(repo,'app.js'),'export const ready=true;');git(['add','.']);git(['commit','-m','base']);const base=git(['rev-parse','HEAD']);
  const task={id:'task-'+'d'.repeat(64),title:'Add filter',goal:'Filter open tasks',acceptance:['Empty results'],session:{id:'session',base},binding:{repo:'test/repo',allowedPaths:['src/'],validation:['npm test']}};
  writeFileSync(shim,`import assert from 'node:assert/strict';let sent;globalThis.fetch=async(url,options={})=>{
   const body=options.body?JSON.parse(options.body):null;
   if(url.endsWith('/claim'))return Response.json(${JSON.stringify(task)});
   if(url.endsWith('/checkpoint'))return Response.json({saved:true});
   if(url.includes('/sessions/session/events')){
    if(options.method==='POST'){assert.equal(body.events.length,1);sent=body.events[0];assert.equal(sent.type,'user.message');assert.ok(sent.content[0].text.startsWith('PA_TASK '));assert.ok(!sent.content[0].text.includes('private-model-secret'));return Response.json({});}
    return Response.json({data:sent?[sent,{type:'agent.tool_result'},{type:'session.status_idle'}]:[]});
   }
   if(url.includes('/files?'))return Response.json({data:[{id:'patch',filename:'change.patch'}]});
   if(url.endsWith('/files/patch/content'))return new Response('diff --git a/src/task.js b/src/task.js\\n');
   throw Error('Unexpected request '+url);
  };`);
  const result=execFileSync(process.execPath,['--import',shim,runner,'prepare'],{cwd:repo,env:{...process.env,RUNNER_TEMP:root,GITHUB_OUTPUT:output,GITHUB_REPOSITORY:'test/repo',GITHUB_RUN_ID:'1',PA_TASK_ID:task.id,PA_BIGMODEL_KEY:'private-model-secret',PA_PLATFORM:JSON.stringify({origin:'https://example.test',projectId:'project',token:'private-platform-secret'})},stdio:['pipe','pipe','pipe']}).toString();
  assert.match(result,/Managed Agent patch ready/);assert.equal(readFileSync(output,'utf8'),'base='+base+'\n');
  const saved=JSON.parse(readFileSync(join(root,'pa-change/task.json')));assert.equal(saved.session.id,'session');assert.match(saved.checksum,/^[a-f0-9]{64}$/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
for(const passes of [true,false])test('real Git patch and test command '+(passes?'pass without secrets':'failure stops validation'),()=>{
 const root=mkdtempSync(join(tmpdir(),'pa-runner-test-')),repo=join(root,'repo'),artifact=join(root,'pa-change');mkdirSync(repo);mkdirSync(artifact);mkdirSync(join(repo,'src'));mkdirSync(join(repo,'test'));
 const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 try{
  git(['init','-b','main']);git(['config','user.email','test@example.invalid']);git(['config','user.name','Connector Test']);
  writeFileSync(join(repo,'src/calc.mjs'),'export const add=(a,b)=>a;\n');git(['add','.']);git(['commit','-m','base']);const base=git(['rev-parse','HEAD']);
  writeFileSync(join(repo,'src/calc.mjs'),'export const add=(a,b)=>a+b;\n');
  writeFileSync(join(repo,'test/calc.test.mjs'),`import assert from 'node:assert/strict';import {add} from '../src/calc.mjs';assert.equal(add(1,1),${passes?2:3});assert.equal(process.env.PA_PLATFORM,undefined);assert.equal(process.env.PA_BIGMODEL_KEY,undefined);`);
  git(['add','.']);const patch=execFileSync('git',['diff','--cached','--binary'],{cwd:repo});git(['reset','--hard','HEAD']);
  writeFileSync(join(artifact,'change.patch'),patch);writeFileSync(join(artifact,'task.json'),JSON.stringify({id:'task-'+'c'.repeat(64),session:{base},checksum:createHash('sha256').update(patch).digest('hex'),binding:{validation:['node --test'],allowedPaths:['src/','test/']}}));
  const run=()=>execFileSync(process.execPath,[runner,'verify'],{cwd:repo,env:{...process.env,RUNNER_TEMP:root,PA_PLATFORM:'must-not-reach-tests',PA_BIGMODEL_KEY:'must-not-reach-tests'},stdio:['pipe','pipe','pipe']});
  if(passes){assert.match(run().toString(),/Project validation passed/);assert.match(readFileSync(join(repo,'src/calc.mjs'),'utf8'),/a\+b/);}else assert.throws(run);
 }finally{rmSync(root,{recursive:true,force:true});}
});
for(const accepted of [true,false])test('cloud coordinator '+(accepted?'deduplicates exports and acknowledges after ingestion':'does not acknowledge failed ingestion'),()=>{
 const root=mkdtempSync(join(tmpdir(),'pa-coordinator-test-')),log=join(root,'events.jsonl'),shim=join(root,'fetch.mjs');
 const meeting={sourceOpenId:'ou_test',externalId:'meeting-1',title:'Meeting',transcript:'Source transcript'};
 writeFileSync(shim,`import {appendFileSync} from 'node:fs';globalThis.fetch=async(url,options={})=>{appendFileSync(${JSON.stringify(log)},JSON.stringify({url,method:options.method})+'\\n');if(url.includes('/api/runner/meeting'))return Response.json(${accepted?'{taskIds:["task-1"]}':'{error:"ingestion_failed"}'},{status:${accepted?200:502}});if(url.includes('/api/runner/tick'))return Response.json({processed:0});if(url.includes('/deployment_runs?'))return Response.json({data:[{session_id:'session-1'},{session_id:'session-2'}]});if(url.includes('/files?'))return Response.json({data:[{id:'file-1',filename:'meeting.json'}]});if(url.includes('/content'))return Response.json(${JSON.stringify(meeting)});if(options.method==='DELETE')return new Response(null,{status:204});if(url.includes('/memories'))return Response.json({});throw Error('Unexpected URL');};`);
 const run=()=>execFileSync(process.execPath,['--import',shim,runner,'tick'],{env:{...process.env,RUNNER_TEMP:root,GITHUB_RUN_ID:'9',PA_PLATFORM:JSON.stringify({origin:'https://example.test',token:'token',projectId:'project',bridgeDeployment:'exporter',bridgeMemory:'memory',bypass:'site'}),PA_BIGMODEL_KEY:'model-test'},stdio:['pipe','pipe','pipe']});
 try{
  if(accepted)assert.match(run().toString(),/meetings=1/);else assert.throws(run);
  const events=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.url.includes('/api/runner/meeting')).length,1);
  assert.equal(events.filter(e=>e.url.includes('/memories')).length,accepted?1:0);
  assert.equal(events.filter(e=>e.method==='DELETE').length,accepted?1:0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
