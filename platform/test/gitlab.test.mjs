import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {open,Fault} from '../security.mjs';

async function fixture(){
 const env={DB:database(),PA_ORIGIN:'https://example.test',PA_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};
 let username='alice',scopes=['api'],catalog=[{id:11,name:'Desk',name_with_namespace:'Team / Desk',path_with_namespace:'team/desk',web_url:'https://gitlab.com/team/desk',issues_enabled:true}],status=200,issueCount=0,noteCount=0,loseIssue=false,loseNote=false;
 const issues=[],notes=[],calls=[];
 const p=new Platform(env,{fetcher:async(url,opt)=>{
  const u=new URL(url);assert.equal(u.origin,'https://gitlab.com');assert.match(opt.headers.authorization,/^Bearer glpat-/);calls.push({path:u.pathname+u.search,method:opt.method,body:opt.body});
  if(status!==200)return Response.json({message:'Denied'},{status});
  const path=u.pathname.replace('/api/v4',''),body=opt.body?JSON.parse(opt.body):null;
  if(path==='/personal_access_tokens/self')return Response.json({active:true,revoked:false,scopes});
  if(path==='/user')return Response.json({id:username==='alice'?1:2,username});
  if(path==='/projects')return Response.json(catalog);
  if(path==='/projects/11/issues'&&opt.method==='GET')return Response.json(issues.filter(i=>i.description.includes(u.searchParams.get('search'))));
  if(path==='/projects/11/issues'&&opt.method==='POST'){issueCount++;const i={iid:issueCount,project_id:11,web_url:'https://gitlab.com/team/desk/-/issues/'+issueCount,...body};issues.push(i);if(loseIssue){loseIssue=false;throw Error('lost create response');}return Response.json(i);}
  if(path==='/projects/11/issues/1/notes'&&opt.method==='GET')return Response.json(notes);
  if(path==='/projects/11/issues/1/notes'&&opt.method==='POST'){noteCount++;notes.push({id:noteCount,...body});if(loseNote){loseNote=false;throw Error('lost note response');}return Response.json(notes.at(-1));}
  throw Error('Unhandled '+path);
 }});
 await p.register('A','A');await p.saveGitlab('A',{token:'glpat-private-owner-A'});
 const c=await p.store.connection('A','gitlab'),project=(await p.store.all('SELECT * FROM pa_projects'))[0];
 return {env,p,c,project,calls,issues,notes,count:()=>({issues:issueCount,notes:noteCount}),setUser:x=>username=x,setScopes:x=>scopes=x,setCatalog:x=>catalog=x,setStatus:x=>status=x,loseIssue:()=>loseIssue=true,loseNote:()=>loseNote=true};
}
const task={id:'task-example',title:'Desk read-only count',goal:'Implement the confirmed count',acceptance:['Empty data shows zero'],evidence:'Desk read-only count',sourceEvidence:[{sourceId:'summary',quote:'Empty data shows zero'}],meetingUrl:'https://example.test/meeting',sourceKind:'meeting_todos',fidelityReview:{approved:true},result:{pr:'https://github.com/team/code/pull/1',tests:'npm test',commit:'abc',runUrl:'https://github.com/team/code/actions/runs/1'}};
test('GitLab PAT validates api scope, encrypts per owner, syncs projects and never exposes the token',async()=>{
 const f=await fixture();assert.equal(f.c.identity.name,'alice');assert.equal((await open(f.env.PA_ENCRYPTION_KEY,f.c.credential,f.c.id)).access_token,'glpat-private-owner-A');assert.equal(JSON.stringify(await f.p.state('A')).includes('glpat-'),false);assert.equal(f.project.external_id,'11');assert.equal(f.project.name,'Team / Desk');assert.equal((await f.p.state('B')).projects.length,0);
 f.setScopes(['read_api']);await assert.rejects(()=>f.p.saveGitlab('B',{token:'glpat-insufficient-key'}),{code:'gitlab_api_scope_required'});assert.equal(await f.p.store.connection('B','gitlab'),null);
 f.setScopes(['api']);f.setUser('bob');await assert.rejects(()=>f.p.saveGitlab('A',{token:'glpat-other-user-key'}),{code:'different_account_disconnect_first'});assert.equal((await f.p.store.connection('A','gitlab')).identity.name,'alice');f.env.DB.raw.close();
});
test('GitLab Issue creation and PR backfill reconcile lost responses and repeated callbacks',async()=>{
 const f=await fixture(),token=await f.p.access(f.c);f.loseIssue();await assert.rejects(()=>f.p.providers.issue('gitlab',token,f.project,task),/lost create response/);
 const original=await f.p.providers.issue('gitlab',token,f.project,task);assert.equal(original.id,'1');assert.equal(original.projectId,'11');assert.ok(f.issues[0].description.includes('Empty data shows zero'));
 f.loseNote();await assert.rejects(()=>f.p.providers.backfill('gitlab',token,f.project,{...task,original}),/lost note response/);
 for(let round=0;round<2;round++){await f.p.providers.issue('gitlab',token,f.project,task);await f.p.providers.backfill('gitlab',token,f.project,{...task,original});}
 assert.deepEqual(f.count(),{issues:1,notes:1});assert.ok(f.notes[0].body.includes(task.result.pr));assert.ok(f.notes[0].body.includes('需求证据核对'));f.env.DB.raw.close();
});
test('GitLab never writes a result to another project and refuses unverified existing-issue URLs',async()=>{
 const f=await fixture(),token=await f.p.access(f.c);
 await assert.rejects(()=>f.p.providers.backfill('gitlab',token,f.project,{...task,original:{id:'1',projectId:'12'}}),{code:'issue_project_mismatch'});
 await assert.rejects(()=>f.p.providers.issue('gitlab',token,f.project,{...task,issueUrl:'https://gitlab.com/other/repo/-/issues/1'}),{code:'gitlab_existing_issue_not_supported'});assert.deepEqual(f.count(),{issues:0,notes:0});f.env.DB.raw.close();
});
test('GitLab project refresh preserves binding and an authorization failure cannot erase the catalog',async()=>{
 const f=await fixture();await f.p.store.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify({repo:'team/code',aliases:['Desk']}),f.project.id);
 f.setCatalog([{id:11,name:'Renamed',web_url:'https://gitlab.com/team/desk',issues_enabled:true}]);await f.p.sync('A',f.c.id);const next=await f.p.store.own('projects',f.project.id,'A');assert.equal(next.name,'Renamed');assert.equal(next.binding.repo,'team/code');
 f.setStatus(401);await assert.rejects(()=>f.p.sync('A',f.c.id),{code:'provider_http_401'});assert.equal((await f.p.store.own('projects',f.project.id,'A')).active,1);assert.equal((await f.p.store.connection('A','gitlab')).status,'needs_auth');f.env.DB.raw.close();
});
test('GitLab pagination reads all pages and fails closed when the provider does not terminate',async()=>{
 const f=await fixture();let pages=0;f.p.providers.gl=async()=>{pages++;return pages===1?Array.from({length:100},(_,id)=>({id})):[];};assert.equal((await f.p.providers.glPages('key','/projects?membership=true')).length,100);assert.equal(pages,2);
 f.p.providers.gl=async()=>Array.from({length:100},(_,id)=>({id}));await assert.rejects(()=>f.p.providers.glPages('key','/projects'),{code:'pagination_limit'});f.env.DB.raw.close();
});
