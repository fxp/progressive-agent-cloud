import sealedbox from 'tweetnacl-sealedbox-js';
import {Fault,random,hash,seal,open,b64,unb64} from '../security.mjs';
import {WORKFLOW_PATH,workflow} from './github-workflow.mjs';
class GitHubRepository{
 constructor({platform,runnerSource}){this.p=platform;this.s=platform.store;this.runnerSource=runnerSource;}
 async client(project){const c=await this.s.own('connections',project.binding.repositoryConnectionId??project.binding.githubConnectionId,project.user_id),token=await this.p.access(c);return (path,body,method)=>this.p.providers.gh(token,'/repos/'+project.binding.repo+path,body,method);}
 async refreshCredentials(user,project,platformConfig){
  const gh=await this.client(project),publicKey=await gh('/actions/secrets/public-key'),provider=project.binding.agent??'bigmodel',credential=await this.p.executionCredential(user,provider);
  const secrets=[['PA_AGENT_CONFIG',JSON.stringify({...credential,provider})],...(provider==='bigmodel'?[['PA_BIGMODEL_KEY',credential.apiKey]]:[]),...(platformConfig?[['PA_PLATFORM',JSON.stringify(platformConfig)]]:[])];
  for(const [name,value]of secrets){if(!value)throw new Fault(503,'agent_key_missing');await gh('/actions/secrets/'+name,{encrypted_value:b64(sealedbox.seal(new TextEncoder().encode(value),unb64(publicKey.key))),key_id:publicKey.key_id},'PUT');}
  if(provider!=='bigmodel')try{await gh('/actions/secrets/PA_BIGMODEL_KEY',undefined,'DELETE');}catch(error){if(error.code!=='provider_http_404')throw error;}
 }
  async install(user,id){
    const project=await this.s.own('projects',id,user);const b=project.binding;
    if(!project.active||!b)throw new Fault(409,'project_binding_required');
    const active=await this.s.one("SELECT id FROM pa_tasks WHERE project_id=? AND status IN ('dispatching','running','backfilling') LIMIT 1",id);
    if(active)throw new Fault(409,'project_has_active_run');
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
          const managedSha=file.path===WORKFLOW_PATH?b.workflowSha:b.runnerSha;
          if(!text.includes('Managed by Progressive Agent Connector v1')&&existing.sha!==managedSha)throw new Fault(409,'runner_file_already_exists');
        }catch(e){if(e.code!=='provider_http_404')throw e;}
      }
      await this.refreshCredentials(user,project,platformConfig);
      const tree=await gh('/git/trees',{base_tree:(await gh('/git/commits/'+base.object.sha)).tree.sha,tree:files.map(f=>({path:f.path,mode:'100644',type:'blob',content:f.content}))});
      const commit=await gh('/git/commits',{message:'Configure Progressive Agent cloud Connector',tree:tree.sha,parents:[base.object.sha]});
      await gh('/git/refs/heads/'+encodeURIComponent(b.baseBranch),{sha:commit.sha,force:false},'PATCH');
      // Both files are installed in a single commit; verify the workflow used by future runs.
      const installed=await gh('/contents/'+WORKFLOW_PATH+'?ref='+commit.sha);
      const installedRunner=await gh('/contents/.github/progressive-agent/runner.mjs?ref='+commit.sha);
      b.runnerReady=true;b.executionVersion='connector-runtime-v1';b.workflowSha=installed.sha;b.runnerSha=installedRunner.sha;b.runnerTokenHash=await hash(secret);
      b.runnerCredential=await seal(this.p.env.PA_ENCRYPTION_KEY,secret,'runner:'+id);
      await this.s.run('UPDATE pa_projects SET binding=? WHERE id=?',JSON.stringify(b),id);
      return {installed:true,commit:commit.sha};
    }finally{await release();}
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
 async verify(p,task,input){const gh=await this.client(p);
        const run=await gh('/actions/runs/'+input.runId);
        const jobs=await gh('/actions/runs/'+input.runId+'/jobs?filter=latest&per_page=100');
        const installed=await gh('/contents/'+WORKFLOW_PATH+'?ref='+run.head_sha);
        const installedRunner=await gh('/contents/.github/progressive-agent/runner.mjs?ref='+run.head_sha);
        if(run.path!==WORKFLOW_PATH||run.display_title!=='PA '+task.id||run.event!=='workflow_dispatch'||installed.sha!==p.binding.workflowSha||installedRunner.sha!==p.binding.runnerSha||!jobs.jobs.some(j=>j.name==='verify'&&j.conclusion==='success'))throw new Fault(409,'verification_not_confirmed');
return run;
 }
 async baseline(p,task,input){const gh=await this.client(p);
        const baseline=[];
        if(task.fidelityVersion===1)for(const f of input.files){
          try{const old=await gh('/contents/'+f.path.split('/').map(encodeURIComponent).join('/')+'?ref='+input.base);if(old.encoding==='base64')baseline.push({path:f.path,content:new TextDecoder().decode(unb64(old.content.replaceAll('\n','')))});}
          catch(error){if(error.code!=='provider_http_404')throw error;baseline.push({path:f.path,missing:true});}
        }
return baseline;
 }
 async publish(p,task,input,run){const gh=await this.client(p);
        const branch='codex/pa-'+task.id.slice(-16);let head;
        try{head=(await gh('/git/ref/heads/'+branch)).object.sha;}catch(e){if(e.code!=='provider_http_404')throw e;}
        if(head){
          const commit=await gh('/git/commits/'+head);
          if(!commit.message.includes('[PA:'+task.id+']'))throw new Fault(409,'task_branch_conflict');
        }else{
          const base=await gh('/git/commits/'+input.base);
          const entries=[];
          for(const f of input.files){
            const blob=f.deleted?null:await gh('/git/blobs',{content:f.content,encoding:'base64'});
            entries.push({path:f.path,type:'blob',mode:'100644',sha:blob?.sha??null});
          }
          const tree=await gh('/git/trees',{base_tree:base.tree.sha,tree:entries});
          head=(await gh('/git/commits',{message:task.title+'\n\n[PA:'+task.id+']',tree:tree.sha,parents:[input.base]})).sha;
          await gh('/git/refs',{ref:'refs/heads/'+branch,sha:head});
        }
        const pulls=await gh('/pulls?state=all&head='+encodeURIComponent(p.binding.repo.split('/')[0]+':'+branch));
        const pr=pulls[0]??await gh('/pulls',{title:task.title,head:branch,base:p.binding.baseBranch,draft:true,body:['来源需求：'+task.original.url,'来源会议：'+task.meetingUrl,'', '验收命令：',...p.binding.validation.map(c=>'- `'+c+'`'),'',`<!-- progressive-agent:${task.id} -->`].join('\n')});
        if(pr.head?.sha!==head)throw new Fault(409,'pull_request_commit_mismatch');
        return {pr:pr.html_url,commit:head,tests:p.binding.validation.join(' ; '),runUrl:run.html_url};

 }
}

export const githubRepository={
 refreshCredentials:(ctx,...args)=>new GitHubRepository(ctx).refreshCredentials(...args),
 repository:({platform:p},token,repo)=>p.providers.repository(token,repo),
 repositories:({platform:p},token)=>p.providers.repositories(token),
 install:(ctx,...args)=>new GitHubRepository(ctx).install(...args),
 verify:(ctx,...args)=>new GitHubRepository(ctx).verify(...args),
 baseline:(ctx,...args)=>new GitHubRepository(ctx).baseline(...args),
 publish:(ctx,...args)=>new GitHubRepository(ctx).publish(...args),
 verification:(ctx,...args)=>new GitHubRepository(ctx).verification(...args),
 async dispatch(ctx,project,task){const gh=await new GitHubRepository(ctx).client(project);return gh('/actions/workflows/progressive-agent.yml/dispatches',{ref:project.binding.baseBranch,inputs:{task_id:task.id}});},
 async runs(ctx,project){const gh=await new GitHubRepository(ctx).client(project);return (await gh('/actions/workflows/progressive-agent.yml/runs?event=workflow_dispatch&per_page=100')).workflow_runs;},
 async run(ctx,project,id){const gh=await new GitHubRepository(ctx).client(project);return gh('/actions/runs/'+id);},
 async rerun(ctx,project,id){const gh=await new GitHubRepository(ctx).client(project);return gh('/actions/runs/'+id+'/rerun-failed-jobs',{});},
};
