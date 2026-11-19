import sealedbox from 'tweetnacl-sealedbox-js';
import {Fault, random, hash, seal, open, b64, unb64} from './security.mjs';
import {reviewChange} from './fidelity.mjs';

export const WORKFLOW_PATH='.github/workflows/progressive-agent.yml';
export function workflow(){return `# Managed by Progressive Agent Connector v1
name: Progressive Agent
run-name: PA \${{ inputs.task_id }}
on:
  schedule:
    - cron: '2-59/5 * * * *'
  workflow_dispatch:
    inputs:
      task_id:
        required: true
        type: string
permissions:
  contents: read
concurrency:
  group: pa-\${{ inputs.task_id }}
  cancel-in-progress: false
jobs:
  wake:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - name: Sync meeting artifacts and advance the project queue
        env:
          PA_PLATFORM: \${{ secrets.PA_PLATFORM }}
          PA_BIGMODEL_KEY: \${{ secrets.PA_BIGMODEL_KEY }}
        run: node .github/progressive-agent/runner.mjs tick
  prepare:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 18
    outputs:
      base: \${{ steps.prepare.outputs.base }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Implement with Managed Agent
        id: prepare
        env:
          PA_PLATFORM: \${{ secrets.PA_PLATFORM }}
          PA_BIGMODEL_KEY: \${{ secrets.PA_BIGMODEL_KEY }}
          PA_TASK_ID: \${{ inputs.task_id }}
        run: node .github/progressive-agent/runner.mjs prepare
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: pa-change
          path: \${{ runner.temp }}/pa-change
          retention-days: 3
          if-no-files-found: error
  verify:
    needs: prepare
    runs-on: ubuntu-latest
    timeout-minutes: 12
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ needs.prepare.outputs.base }}
          path: project
          persist-credentials: false
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: pa-change
          path: \${{ runner.temp }}/pa-change
      - name: Validate proposed changes
        working-directory: project
        run: node ../.github/progressive-agent/runner.mjs verify
  publish:
    needs: [prepare, verify]
    runs-on: ubuntu-latest
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ needs.prepare.outputs.base }}
          path: project
          persist-credentials: false
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: pa-change
          path: \${{ runner.temp }}/pa-change
      - name: Create PR and backfill requirement
        working-directory: project
        env:
          PA_PLATFORM: \${{ secrets.PA_PLATFORM }}
          PA_TASK_ID: \${{ inputs.task_id }}
        run: node ../.github/progressive-agent/runner.mjs publish
`;}

export function allowedPath(path, allowed){
  return typeof path==='string' && /^[\w./-]+$/.test(path) && !path.startsWith('/') && !path.split('/').includes('..') && !path.split('/').some(p=>p==='.git'||p==='.github'||p.startsWith('.env')) && allowed.some(p=>p.endsWith('/')?path.startsWith(p):path===p);
}

export class Execution {
  constructor(platform,runnerSource){this.p=platform;this.s=platform.store;this.runnerSource=runnerSource;}
  async refreshAgentSecrets(user){
    const key=await this.p.agentKey(user),projects=await this.s.all('SELECT * FROM pa_projects WHERE user_id=? AND active=1 AND binding IS NOT NULL',user);const failed=[];
    for(const project of projects.filter(p=>p.binding.runnerReady))try{
      const c=await this.s.own('connections',project.binding.githubConnectionId,user),token=await this.p.access(c),root='/repos/'+project.binding.repo;
      const publicKey=await this.p.providers.gh(token,root+'/actions/secrets/public-key');
      await this.p.providers.gh(token,root+'/actions/secrets/PA_BIGMODEL_KEY',{encrypted_value:b64(sealedbox.seal(new TextEncoder().encode(key),unb64(publicKey.key))),key_id:publicKey.key_id},'PUT');
    }catch{
      project.binding.runnerReady=false;await this.s.run('UPDATE pa_projects SET binding=? WHERE id=? AND user_id=?',JSON.stringify(project.binding),project.id,user);failed.push(project.id);
    }
    return {reinstall:failed};
  }
  async install(user,id){
    const project=await this.s.own('projects',id,user);const b=project.binding;
    if(!project.active||!b)throw new Fault(409,'project_binding_required');
    const claim=await this.s.one('SELECT project_id,user_id FROM pa_repo_claims WHERE repo=?',b.repo.toLowerCase());
    if(claim?.project_id!==project.id||claim?.user_id!==user)throw new Fault(409,'repository_already_managed');
    const release=await this.s.lease('install:'+b.repo,120000);
    try{
      const conn=await this.s.own('connections',b.githubConnectionId,user);const token=await this.p.access(conn);
      const gh=(path,body,method)=>this.p.providers.gh(token,'/repos/'+b.repo+path,body,method);
      const secret=b.runnerCredential?await open(this.p.env.PA_ENCRYPTION_KEY,b.runnerCredential,'runner:'+id):random();const platformConfig={origin:this.p.env.PA_ORIGIN,projectId:id,token:secret,bypass:this.p.env.PA_SITE_BYPASS,cloudCoordinator:this.p.env.PA_AUTH_MODE==='github',bridgeDeployment:this.p.env.PA_BRIDGE_DEPLOYMENT,bridgeMemory:this.p.env.PA_BRIDGE_MEMORY};
      if(this.p.env.PA_AUTH_MODE!=='github'&&!platformConfig.bypass)throw new Fault(503,'service_access_missing');
      try{const legacy=await gh('/actions/workflows/focus-board-relay.yml');if(legacy.state==='active')throw new Fault(409,'legacy_relay_active');}catch(e){if(e.code!=='provider_http_404')throw e;}
      const base=await gh('/git/ref/heads/'+encodeURIComponent(b.baseBranch));
      const files=[{path:WORKFLOW_PATH,content:workflow()},{path:'.github/progressive-agent/runner.mjs',content:this.runnerSource}];
      for(const file of files){
        try{const existing=await gh('/contents/'+file.path+'?ref='+encodeURIComponent(b.baseBranch));
          const text=new TextDecoder().decode(unb64(existing.content.replaceAll('\n','')));
          if(!text.includes('Managed by Progressive Agent Connector v1'))throw new Fault(409,'runner_file_already_exists');
        }catch(e){if(e.code!=='provider_http_404')throw e;}
      }
      const publicKey=await gh('/actions/secrets/public-key');
      for(const [name,value]of [['PA_PLATFORM',JSON.stringify(platformConfig)],['PA_BIGMODEL_KEY',await this.p.agentKey(user)]]){
        if(!value)throw new Fault(503,'agent_key_missing');
        const encrypted=sealedbox.seal(new TextEncoder().encode(value),unb64(publicKey.key));
        await gh('/actions/secrets/'+name,{encrypted_value:b64(encrypted),key_id:publicKey.key_id},'PUT');
      }
      const tree=await gh('/git/trees',{base_tree:(await gh('/git/commits/'+base.object.sha)).tree.sha,tree:files.map(f=>({path:f.path,mode:'100644',type:'blob',content:f.content}))});
      const commit=await gh('/git/commits',{message:'Configure Progressive Agent cloud Connector',tree:tree.sha,parents:[base.object.sha]});
      await gh('/git/refs/heads/'+encodeURIComponent(b.baseBranch),{sha:commit.sha,force:false},'PATCH');
      // Both files are installed in a single commit; verify the workflow used by future runs.
      const installed=await gh('/contents/'+WORKFLOW_PATH+'?ref='+commit.sha);
      const installedRunner=await gh('/contents/.github/progressive-agent/runner.mjs?ref='+commit.sha);
      b.runnerReady=true;b.executionVersion='evidence-repair-v1';b.workflowSha=installed.sha;b.runnerSha=installedRunner.sha;b.runnerTokenHash=await hash(secret);
      b.runnerCredential=await seal(this.p.env.PA_ENCRYPTION_KEY,secret,'runner:'+id);
      await this.s.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(b),id);
      return {installed:true,commit:commit.sha};
    }finally{await release();}
  }
  async tick(projectId,userId){
    const synced=[];
    const project=projectId?await this.s.one('SELECT * FROM pa_projects WHERE id=?',projectId):null;
    const owner=project?.user_id??userId;
    const connections=await this.s.all("SELECT * FROM pa_connections WHERE kind='project' AND status<>'disconnected' AND (synced_at IS NULL OR synced_at<?)"+(owner?' AND user_id=?':''),this.p.now()-240000,...(owner?[owner]:[]));
    for(const connection of connections.slice(0,8)){
      try{await this.p.sync(connection.user_id,connection.id);synced.push(connection.id);}catch{ /* Error is persisted on the connector. */ }
    }
    const rows=await this.s.all("SELECT * FROM pa_tasks WHERE (status IN ('queued','backfilling','dispatching','running') OR (status='failed' AND json_extract(payload,'$.fidelityReview.approved')=0 AND COALESCE(json_extract(payload,'$.repairRevision'),0)=0))"+(project?' AND project_id=?':owner?' AND user_id=?':'')+" ORDER BY updated_at LIMIT 20",...(project?[project.id]:owner?[owner]:[]));
    for(const row of rows){
      const release=await this.s.lease('task:'+row.id,90000).catch(()=>null);if(!release)continue;
      try{await this.advance(row);}catch(error){row.payload.error=error.code??'execution_failed';await this.s.saveTask(row,row.payload.result?'backfilling':row.status==='dispatching'&&error.code!=='dispatch_needs_reconciliation'?'dispatching':'failed');}finally{await release();}
    }
    return {synced:synced.length,processed:rows.length};
  }
  async advance(row){
    if(row.payload.retryAfter>this.p.now())return;
    if(row.payload.requiresClarification){await this.s.saveTask(row,'needs_info');return;}
    const p=await this.s.own('projects',row.project_id,row.user_id);const b=p.binding;
    const meeting=row.payload.sourceConnectionId?await this.s.own('connections',row.payload.sourceConnectionId,row.user_id):await this.s.connection(row.user_id,'feishu');
    if(meeting?.provider==='meeting-webhook'&&meeting.status!=='connected')throw new Fault(409,'meeting_connector_not_active');
    if(meeting?.identity.appType==='store'){if(meeting.status!=='connected')throw new Fault(409,'meeting_connector_not_active');await (await import('./feishu-store.mjs')).assertTenant(this.p,meeting);}
    if(!p.active||!b)throw new Fault(409,'project_not_available');
    const source=await this.s.own('connections',p.connection_id,row.user_id);
    const sourceToken=await this.p.access(source);
    const ghConn=await this.s.own('connections',b.githubConnectionId,row.user_id);
    const token=await this.p.access(ghConn);
    if(row.payload.result){
      await this.p.providers.backfill(source.provider,sourceToken,p,row.payload);
      row.payload.error=null;await this.s.saveTask(row,'review_ready');return;
    }
    if(!b.runnerReady){row.payload.error='runner_installation_required';await this.s.saveTask(row,'queued');return;}
    const agent=await this.s.connection(row.user_id,'bigmodel');if(agent?.status!=='connected')throw new Fault(409,'agent_not_connected');
    const gh=(path,body)=>this.p.providers.gh(token,'/repos/'+b.repo+path,body);
    if(row.status==='running'||row.status==='failed'){
      const run=await gh('/actions/runs/'+row.payload.githubRunId);
      if(run.status==='completed'&&run.conclusion==='failure'&&row.payload.fidelityReview?.approved===false&&!row.payload.repairRevision&&b.automatic&&b.sourceEnabled&&meeting?.status==='connected'){
        if(b.executionVersion!=='evidence-repair-v1')throw new Fault(409,'runner_installation_required');
        row.payload.repairRevision=1;
        row.payload.repairFeedback=row.payload.fidelityReview.violations;
        row.payload.rejectedRuns=[...(row.payload.rejectedRuns??[]),{id:row.payload.githubRunId,review:row.payload.fidelityReview}];
        row.payload.previousRejectedChecksum=row.payload.patchChecksum;
        delete row.payload.githubRunId;delete row.payload.patchChecksum;delete row.payload.fidelityReview;
        row.payload.error=null;row.status='queued';await this.s.saveTask(row);
      }else{
        if(run.status==='completed'&&run.conclusion!=='success')throw new Fault(409,'cloud_runner_failed');
        return;
      }
    }
    if(!row.payload.original){
      row.payload.original=await this.p.providers.issue(source.provider,sourceToken,p,row.payload);
      await this.s.saveTask(row);
    }
    const prior=await gh('/actions/workflows/progressive-agent.yml/runs?event=workflow_dispatch&per_page=100');
    const run=prior.workflow_runs.find(r=>r.display_title==='PA '+row.id&&!row.payload.rejectedRuns?.some(old=>old.id===String(r.id)));
    if(run){row.payload.githubRunId=String(run.id);row.payload.runUrl=run.html_url;await this.s.saveTask(row,'running');return;}
    if(row.status==='dispatching'){
      if(this.p.now()-row.updated_at>900000)throw new Fault(409,'dispatch_needs_reconciliation');
      return;
    }
    row.status='dispatching';await this.s.saveTask(row);
    await gh('/actions/workflows/progressive-agent.yml/dispatches',{ref:b.baseBranch,inputs:{task_id:row.id}});
  }
  async verification(user,id){
    const row=await this.s.own('tasks',id,user),result=row.payload.result;
    if(!result)throw new Fault(409,'task_result_required');
    const p=await this.s.own('projects',row.project_id,user),repo=p.binding?.repo;
    const prefix='https://github.com/'+repo;
    const number=result.pr?.startsWith(prefix+'/pull/')?/^\d+$/.test(result.pr.slice((prefix+'/pull/').length))?result.pr.slice((prefix+'/pull/').length):null:null;
    const runId=row.payload.githubRunId;
    if(!repo||!number||!/^\d+$/.test(String(runId??'')))throw new Fault(409,'task_result_mismatch');
    const connection=await this.s.own('connections',p.binding.githubConnectionId,user),token=await this.p.access(connection);
    const gh=path=>this.p.providers.gh(token,'/repos/'+repo+path);
    const branch='codex/pa-'+row.id.slice(-16);
    const [run,jobs,pr,pulls]=await Promise.all([gh('/actions/runs/'+runId),gh('/actions/runs/'+runId+'/jobs?filter=latest&per_page=100'),gh('/pulls/'+number),gh('/pulls?state=all&head='+encodeURIComponent(repo.split('/')[0]+':'+branch)+'&per_page=100')]);
    const source=await this.s.own('connections',p.connection_id,user);
    let backfill=null;
    if(source.provider==='github'&&/^\d+$/.test(String(row.payload.original?.id??''))){
      const comments=await gh('/issues/'+row.payload.original.id+'/comments?per_page=100');
      const marker='<!-- progressive-agent:'+row.id+':pr -->';
      backfill={comments:comments.filter(c=>c.body?.includes(marker)).map(c=>({id:c.id,body:c.body,url:c.html_url})),complete:comments.length<100};
    }
    if(source.provider==='gitlab'&&row.payload.original?.projectId===p.external_id&&/^\d+$/.test(row.payload.original?.id??'')){
      const comments=await this.p.providers.glPages(await this.p.access(source),'/projects/'+encodeURIComponent(p.external_id)+'/issues/'+row.payload.original.id+'/notes');
      backfill={comments:comments.filter(c=>c.body?.includes('<!-- progressive-agent:'+row.id+':pr -->')).map(c=>({id:c.id,body:c.body,url:row.payload.original.url+'#note_'+c.id})),complete:true};
    }
    return {run:{id:run.id,status:run.status,conclusion:run.conclusion,attempt:run.run_attempt,url:run.html_url},jobs:jobs.jobs.map(j=>({name:j.name,status:j.status,conclusion:j.conclusion,steps:(j.steps??[]).map(s=>({name:s.name,conclusion:s.conclusion}))})),pull:{number:pr.number,state:pr.state,draft:pr.draft,url:pr.html_url,commit:pr.head?.sha},pullCount:pulls.length,pullsComplete:pulls.length<100,backfill};
  }
  async runnerProject(id,secret){
    const p=await this.s.one('SELECT * FROM pa_projects WHERE id=?',id);
    if(!p?.active||!p.binding?.runnerReady||await hash(secret??'')!==p.binding.runnerTokenHash)throw new Fault(401,'runner_unauthorized');
    if(this.p.env.PA_AUTH_MODE==='github'&&!await this.s.one('SELECT id FROM pa_users WHERE id=? AND disabled_at IS NULL',p.user_id))throw new Fault(401,'runner_unauthorized');
    const c=await this.s.own('connections',p.binding.githubConnectionId,p.user_id);
    const agent=await this.s.connection(p.user_id,'bigmodel');
    const meeting=await this.s.connection(p.user_id,'feishu');if(meeting?.identity.appType==='store'){if(meeting.status!=='connected')throw new Fault(401,'runner_unauthorized');await (await import('./feishu-store.mjs')).assertTenant(this.p,meeting);}
    if(c.status==='disconnected'||agent?.status!=='connected')throw new Fault(401,'runner_unauthorized');return p;
  }
  async claim(p,input){
    const row=await this.s.own('tasks',input.taskId,p.user_id);
    if(row.project_id!==p.id||!['dispatching','running'].includes(row.status)||!/^[0-9]+$/.test(input.runId??''))throw new Fault(409,'task_not_claimable');
    const release=await this.s.lease('task:'+row.id,30000);
    try{
      const fresh=await this.s.own('tasks',row.id,p.user_id);
      if(!['dispatching','running'].includes(fresh.status))throw new Fault(409,'task_not_claimable');
      if(fresh.payload.rejectedRuns?.some(old=>old.id===input.runId))throw new Fault(409,'task_claimed_by_another_run');
      if(fresh.payload.githubRunId&&fresh.payload.githubRunId!==input.runId)throw new Fault(409,'task_claimed_by_another_run');
      fresh.payload.githubRunId=input.runId;
      await this.s.saveTask(fresh,'running');
      return {...fresh.payload,binding:{repo:p.binding.repo,baseBranch:p.binding.baseBranch,validation:p.binding.validation,allowedPaths:p.binding.allowedPaths}};
    }finally{await release();}
  }
  async checkpoint(p,input){
    const row=await this.s.own('tasks',input.taskId,p.user_id);
    if(row.project_id!==p.id||row.payload.githubRunId!==input.runId||row.status!=='running')throw new Fault(409,'run_mismatch');
    if(input.session){
      if(!/^[\w-]{1,160}$/.test(input.session.id??'')||!/^[a-f0-9]{40}$/.test(input.session.base??''))throw new Fault(400,'invalid_session');
      if(row.payload.session&&JSON.stringify(row.payload.session)!==JSON.stringify(input.session))throw new Fault(409,'session_already_created');
      row.payload.session=input.session;
    }
    if(input.intent)row.payload.sessionIntent=true;
    if(input.patchChecksum){
      if(!/^[a-f0-9]{64}$/.test(input.patchChecksum)||row.payload.patchChecksum&&row.payload.patchChecksum!==input.patchChecksum)throw new Fault(409,'patch_checksum_conflict');
      row.payload.patchChecksum=input.patchChecksum;
    }
    await this.s.saveTask(row);return {saved:true};
  }
  async complete(p,input){
    const row=await this.s.own('tasks',input.taskId,p.user_id);
    if(row.project_id!==p.id||row.payload.githubRunId!==input.runId)throw new Fault(409,'run_mismatch');
    if(row.status==='review_ready')return row.payload.result;
    const release=await this.s.lease('task:'+row.id,90000);
    try{
      const ghConn=await this.s.own('connections',p.binding.githubConnectionId,p.user_id);
      const token=await this.p.access(ghConn);const root='/repos/'+p.binding.repo;
      const gh=(path,body,method)=>this.p.providers.gh(token,root+path,body,method);
      if(!row.payload.result){
        if(row.status!=='running'||!row.payload.session||input.base!==row.payload.session.base)throw new Fault(409,'base_mismatch');
        if(!row.payload.patchChecksum||input.patchChecksum!==row.payload.patchChecksum)throw new Fault(409,'patch_checksum_mismatch');
        if(!Array.isArray(input.files)||!input.files.length||input.files.length>60||JSON.stringify(input.files).length>1500000)throw new Fault(400,'invalid_change');
        if(input.files.some(f=>!allowedPath(f.path,p.binding.allowedPaths)||(!f.deleted&&typeof f.content!=='string')||f.mode!=='100644'))throw new Fault(400,'change_outside_allowed_paths');
        const run=await gh('/actions/runs/'+input.runId);
        const jobs=await gh('/actions/runs/'+input.runId+'/jobs?filter=latest&per_page=100');
        const installed=await gh('/contents/'+WORKFLOW_PATH+'?ref='+run.head_sha);
        const installedRunner=await gh('/contents/.github/progressive-agent/runner.mjs?ref='+run.head_sha);
        if(run.path!==WORKFLOW_PATH||run.display_title!=='PA '+row.id||run.event!=='workflow_dispatch'||installed.sha!==p.binding.workflowSha||installedRunner.sha!==p.binding.runnerSha||!jobs.jobs.some(j=>j.name==='verify'&&j.conclusion==='success'))throw new Fault(409,'verification_not_confirmed');
        const baseline=[];
        if(row.payload.fidelityVersion===1)for(const f of input.files){
          try{const old=await gh('/contents/'+f.path.split('/').map(encodeURIComponent).join('/')+'?ref='+input.base);if(old.encoding==='base64')baseline.push({path:f.path,content:new TextDecoder().decode(unb64(old.content.replaceAll('\n','')))});}
          catch(error){if(error.code!=='provider_http_404')throw error;baseline.push({path:f.path,missing:true});}
        }
        const fidelity=await reviewChange(this.p,p.user_id,row.payload,input.files,baseline);
        if(fidelity){
          row.payload.fidelityReview=fidelity;await this.s.saveTask(row);
          if(!fidelity.approved)throw new Fault(409,'requirement_fidelity_failed');
        }
        const branch='codex/pa-'+row.id.slice(-16);let head;
        try{head=(await gh('/git/ref/heads/'+branch)).object.sha;}catch(e){if(e.code!=='provider_http_404')throw e;}
        if(head){
          const commit=await gh('/git/commits/'+head);
          if(!commit.message.includes('[PA:'+row.id+']'))throw new Fault(409,'task_branch_conflict');
        }else{
          const base=await gh('/git/commits/'+input.base);
          const entries=[];
          for(const f of input.files){
            const blob=f.deleted?null:await gh('/git/blobs',{content:f.content,encoding:'base64'});
            entries.push({path:f.path,type:'blob',mode:'100644',sha:blob?.sha??null});
          }
          const tree=await gh('/git/trees',{base_tree:base.tree.sha,tree:entries});
          head=(await gh('/git/commits',{message:row.payload.title+'\n\n[PA:'+row.id+']',tree:tree.sha,parents:[input.base]})).sha;
          await gh('/git/refs',{ref:'refs/heads/'+branch,sha:head});
        }
        const pulls=await gh('/pulls?state=all&head='+encodeURIComponent(p.binding.repo.split('/')[0]+':'+branch));
        const pr=pulls[0]??await gh('/pulls',{title:row.payload.title,head:branch,base:p.binding.baseBranch,draft:true,body:['来源需求：'+row.payload.original.url,'来源会议：'+row.payload.meetingUrl,'', '验收命令：',...p.binding.validation.map(c=>'- `'+c+'`'),'',`<!-- progressive-agent:${row.id} -->`].join('\n')});
        if(pr.head?.sha!==head)throw new Fault(409,'pull_request_commit_mismatch');
        row.payload.result={pr:pr.html_url,commit:head,tests:p.binding.validation.join(' ; '),runUrl:run.html_url};
        await this.s.saveTask(row,'backfilling');
      }
      const source=await this.s.own('connections',p.connection_id,p.user_id);
      await this.p.providers.backfill(source.provider,await this.p.access(source),p,row.payload);
      row.payload.error=null;await this.s.saveTask(row,'review_ready');return row.payload.result;
    }finally{await release();}
  }
}
