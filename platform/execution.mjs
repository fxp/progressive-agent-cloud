import {Fault, hash, unb64} from './security.mjs';
import {reviewChange} from './fidelity.mjs';
import {accountEnabled} from './invitations.mjs';

export {WORKFLOW_PATH,workflow} from './connectors/github-workflow.mjs';
import {WORKFLOW_PATH} from './connectors/github-workflow.mjs';

export function allowedPath(path, allowed){
  return typeof path==='string' && /^[\w./-]+$/.test(path) && !path.startsWith('/') && !path.split('/').includes('..') && !path.split('/').some(p=>p==='.git'||p==='.github'||p.startsWith('.env')) && allowed.some(p=>p.endsWith('/')?path.startsWith(p):path===p);
}

export class Execution {
  constructor(platform,runnerSource){this.p=platform;this.s=platform.store;this.runnerSource=runnerSource;}
  context(){return {platform:this.p,runnerSource:this.runnerSource};}
  repository(project){return this.p.registry.get(project.binding?.repository??'github','repository');}
  delivery(source,project){return this.p.registry.get(project.binding?.delivery??source.provider,'delivery');}
  async refreshAgentSecrets(user,provider='bigmodel'){
    const projects=await this.s.all('SELECT * FROM pa_projects WHERE user_id=? AND active=1 AND binding IS NOT NULL',user),failed=[];
    for(const project of projects.filter(p=>p.binding.runnerReady&&(p.binding.agent??'bigmodel')===provider))try{await this.repository(project).refreshCredentials(this.context(),user,project);}catch{project.binding.runnerReady=false;await this.s.run('UPDATE pa_projects SET binding=? WHERE id=? AND user_id=?',JSON.stringify(project.binding),project.id,user);failed.push(project.id);}
    return {reinstall:failed};
  }
  async install(user,id){const project=await this.s.own('projects',id,user);return this.repository(project).install(this.context(),user,id);}
  async tick(projectId,userId){
    const synced=[];
    const project=projectId?await this.s.one('SELECT * FROM pa_projects WHERE id=?',projectId):null;
    const owner=project?.user_id??userId;
    const providers=this.p.registry.list('project').map(m=>m.id);
    const connections=providers.length?await this.s.all("SELECT * FROM pa_connections WHERE provider IN ("+providers.map(()=>'?').join(',')+") AND status<>'disconnected' AND (synced_at IS NULL OR synced_at<?)"+(owner?' AND user_id=?':''),...providers,this.p.now()-240000,...(owner?[owner]:[])):[];
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
    if(row.payload.result){
      await this.delivery(source,p).backfill(this.context(),sourceToken,p,row.payload);
      row.payload.error=null;await this.s.saveTask(row,'review_ready');return;
    }
    if(!b.runnerReady){row.payload.error='runner_installation_required';await this.s.saveTask(row,'queued');return;}
    const agent=await this.s.connection(row.user_id,b.agent??'bigmodel');if(agent?.status!=='connected')throw new Fault(409,'agent_not_connected');
    const repository=this.repository(p),ctx=this.context();
    if(row.status==='running'||row.status==='failed'){
      const run=await repository.run(ctx,p,row.payload.githubRunId);
      if(run.status==='completed'&&run.conclusion==='failure'&&row.payload.fidelityReview?.approved===false&&!row.payload.repairRevision&&b.automatic&&b.sourceEnabled&&meeting?.status==='connected'){
        if(!['evidence-repair-v1','connector-runtime-v1'].includes(b.executionVersion))throw new Fault(409,'runner_installation_required');
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
      row.payload.original=await this.p.registry.get(source.provider,'project').createRequirement(ctx,sourceToken,p,row.payload);
      await this.s.saveTask(row);
    }
    const prior=await repository.runs(ctx,p);
    const run=prior.find(r=>r.display_title==='PA '+row.id&&!row.payload.rejectedRuns?.some(old=>old.id===String(r.id)));
    if(run){row.payload.githubRunId=String(run.id);row.payload.runUrl=run.html_url;await this.s.saveTask(row,'running');return;}
    if(row.status==='dispatching'){
      if(this.p.now()-row.updated_at>900000)throw new Fault(409,'dispatch_needs_reconciliation');
      return;
    }
    row.status='dispatching';await this.s.saveTask(row);
    if(!await accountEnabled(this.p,row.user_id))throw new Fault(403,'account_disabled');
    await repository.dispatch(ctx,p,row.payload);
  }
  async verification(user,id){const task=await this.s.own('tasks',id,user),project=await this.s.own('projects',task.project_id,user);return this.repository(project).verification(this.context(),user,id);}
  async runnerProject(id,secret){
    const p=await this.s.one('SELECT * FROM pa_projects WHERE id=?',id);
    if(!p?.active||!p.binding?.runnerReady||await hash(secret??'')!==p.binding.runnerTokenHash)throw new Fault(401,'runner_unauthorized');
    if(!await accountEnabled(this.p,p.user_id))throw new Fault(401,'runner_unauthorized');
    const c=await this.s.own('connections',p.binding.repositoryConnectionId??p.binding.githubConnectionId,p.user_id);
    const agent=await this.s.connection(p.user_id,p.binding.agent??'bigmodel');
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
      return {...fresh.payload,execution:this.p.registry.get(p.binding.agent??'bigmodel','agent').execution(),binding:{agent:p.binding.agent??'bigmodel',repository:p.binding.repository??'github',repo:p.binding.repo,baseBranch:p.binding.baseBranch,validation:p.binding.validation,allowedPaths:p.binding.allowedPaths}};
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
    if(input.cliIntent){
      if(this.p.registry.get(p.binding.agent??'bigmodel','agent').execution().runtime!=='cli'||input.cliIntent.revision!==(row.payload.repairRevision??0)||row.payload.cliIntent?.revision===input.cliIntent.revision)throw new Fault(409,'cli_intent_conflict');
      row.payload.cliIntent={revision:input.cliIntent.revision,runId:input.runId,at:this.p.now()};
    }
    if(input.cliArtifact){
      const a=input.cliArtifact;
      if(this.p.registry.get(p.binding.agent??'bigmodel','agent').execution().runtime!=='cli'||a.executor!==p.binding.agent||a.revision!==(row.payload.repairRevision??0)||typeof a.patch!=='string'||JSON.stringify(a).length>1200000||a.checksum!==input.patchChecksum||await hash(new TextDecoder().decode(unb64(a.patch)))!==a.checksum)throw new Fault(400,'invalid_cli_artifact');
      row.payload.cliArtifact=a;
    }

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
      const repository=this.repository(p),ctx=this.context();
      if(!row.payload.result){
        if(row.status!=='running'||!row.payload.session||input.base!==row.payload.session.base)throw new Fault(409,'base_mismatch');
        if(!row.payload.patchChecksum||input.patchChecksum!==row.payload.patchChecksum)throw new Fault(409,'patch_checksum_mismatch');
        if(!Array.isArray(input.files)||!input.files.length||input.files.length>60||JSON.stringify(input.files).length>1500000)throw new Fault(400,'invalid_change');
        if(input.files.some(f=>!allowedPath(f.path,p.binding.allowedPaths)||(!f.deleted&&typeof f.content!=='string')||f.mode!=='100644'))throw new Fault(400,'change_outside_allowed_paths');
        const run=await repository.verify(ctx,p,row.payload,input);
        const baseline=await repository.baseline(ctx,p,row.payload,input);
        const fidelity=await reviewChange(this.p,p.user_id,row.payload,input.files,baseline);
        if(fidelity){
          row.payload.fidelityReview=fidelity;await this.s.saveTask(row);
          if(!fidelity.approved)throw new Fault(409,'requirement_fidelity_failed');
        }
        row.payload.result=await repository.publish(ctx,p,row.payload,input,run);
        await this.s.saveTask(row,'backfilling');
      }
      const source=await this.s.own('connections',p.connection_id,p.user_id);
      await this.delivery(source,p).backfill(this.context(),await this.p.access(source),p,row.payload);
      row.payload.error=null;await this.s.saveTask(row,'review_ready');return row.payload.result;
    }finally{await release();}
  }
}
