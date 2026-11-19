import {Platform} from './service.mjs';
import {Execution} from './execution.mjs';
import {scanSource} from './sources.mjs';
import {coordinate} from './coordinator.mjs';
import {Fault,hash} from './security.mjs';

export async function enqueueUser(p,user,{reason='cron'}={}){
  if(!p.env.PA_USER_JOBS)throw new Fault(503,'queue_not_configured');
  const [source,agent]=await Promise.all([p.store.connection(user,'feishu'),p.store.connection(user,'bigmodel')]);
  if(source?.status!=='connected'||agent?.status!=='connected')return {queued:false};
  const bucket=Math.floor(p.now()/(reason==='cron'?300000:60000));
  const id='job-'+await hash(user+':'+(reason==='cron'?'cron':'manual')+':'+bucket);
  const inserted=await p.store.run("INSERT INTO pa_jobs VALUES(?,?,'queued',?,?,NULL) ON CONFLICT(id) DO NOTHING",id,user,p.now(),p.now());
  if(!inserted.meta.changes)return {queued:false};
  try{await p.env.PA_USER_JOBS.send({version:1,jobId:id,userId:user});}catch(error){await p.store.run("UPDATE pa_jobs SET state='failed',error='queue_send_failed' WHERE id=?",id);throw error;}
  return {queued:true};
}

export async function schedule(env,runnerSource,options={}){
  const p=options.platform??new Platform(env);
  if(!env.PA_USER_JOBS){if(env.PA_LEGACY_USER_ID)return coordinate(env,runnerSource,options);throw new Fault(503,'queue_not_configured');}
  // Only ready, enabled accounts are enqueued. Message payloads contain IDs,
  // never OAuth tokens, model keys, transcripts or another user's projects.
  let after='',queued=0;
  for(let page=0;page<100;page++){
    const users=await p.store.all("SELECT DISTINCT c.user_id FROM pa_connections c JOIN pa_users u ON u.id=c.user_id WHERE c.provider='bigmodel' AND c.status='connected' AND u.disabled_at IS NULL AND c.user_id>? ORDER BY c.user_id LIMIT 100",after);
    for(const row of users){const result=await enqueueUser(p,row.user_id);if(result.queued)queued++;}
    if(users.length<100)break;after=users.at(-1).user_id;
  }
  return {queued};
}

export async function consume(batch,env,runnerSource,options={}){
  const p=options.platform??new Platform(env),ex=options.execution??new Execution(p,runnerSource);
  for(const message of batch.messages){
    const body=message.body;
    if(body?.version!==1||typeof body.userId!=='string'||typeof body.jobId!=='string'){message.ack();continue;}
    const job=await p.store.one('SELECT * FROM pa_jobs WHERE id=? AND user_id=?',body.jobId,body.userId);
    if(!job||job.state==='completed'){message.ack();continue;}
    const user=await p.store.one('SELECT * FROM pa_users WHERE id=? AND disabled_at IS NULL',job.user_id);
    if(!user){message.ack();continue;}
    const release=await p.store.lease('user-job:'+job.user_id,600000).catch(e=>{if(e.code==='busy_retry_later')return null;throw e;});
    if(!release){message.retry({delaySeconds:30});continue;}
    try{
      await p.store.run("UPDATE pa_jobs SET state='running',updated_at=? WHERE id=?",p.now(),job.id);
      const source=await p.store.connection(job.user_id,'feishu');
      const agent=await p.store.connection(job.user_id,'bigmodel');
      if(source?.status!=='connected'||agent?.status!=='connected'){
        await p.store.run("UPDATE pa_jobs SET state='completed',updated_at=? WHERE id=?",p.now(),job.id);message.ack();continue;
      }
      let result;
      if(source.credential){
        const scan=await (options.scan??scanSource)(p,source),tick=await ex.tick(undefined,job.user_id);result={...scan,...tick};
      }else if(job.user_id===env.PA_LEGACY_USER_ID){
        result=await coordinate(env,runnerSource,{platform:p,execution:ex,scheduledTime:p.now()});
      }else throw new Fault(409,'meeting_authorization_required');
      await p.store.receipt('run-'+job.id,job.user_id,result,'completed');
      await p.store.run("UPDATE pa_jobs SET state='completed',error=NULL,updated_at=? WHERE id=?",p.now(),job.id);
      message.ack();
    }catch(error){
      const code=error.code??'user_job_failed';
      await p.store.receipt('run-'+job.id,job.user_id,{error:code},'failed');
      await p.store.run("UPDATE pa_jobs SET state='failed',error=?,updated_at=? WHERE id=?",code,p.now(),job.id);
      if(error.status===401){await p.store.run("UPDATE pa_connections SET status='needs_auth',error=? WHERE user_id=? AND provider='feishu'",code,job.user_id);message.ack();}
      else message.retry({delaySeconds:60});
    }finally{await release();}
  }
}
