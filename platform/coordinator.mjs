import {Platform} from './service.mjs';
import {Execution} from './execution.mjs';
import {Fault,hash} from './security.mjs';

// Native Worker cron: consumes protected Managed Agent meeting artifacts.
// Repository runners still perform coding, independent tests and publication.
export async function coordinate(env,runnerSource,{platform,execution,fetcher=fetch,scheduledTime=Date.now()}={}){
  const p=platform??new Platform(env),ex=execution??new Execution(p,runnerSource);
  if(!env.PA_BRIDGE_ENABLED)return {disabled:true};
  const release=await p.store.lease('cloud-coordinator',240000).catch(error=>{
    if(error.code==='busy_retry_later')return null;throw error;
  });
  if(!release)return {busy:true};
  const summary={scheduledTime,ingested:0,processed:0,synced:0};
  const request=async(path,{body,method='GET',raw=false}={})=>{
    const r=await fetcher('https://agent-api.bigmodel.cn/api/agent/managed/v1/'+path,{method,headers:{authorization:'Bearer '+env.PA_BIGMODEL_KEY,'zai-version':'2026-05-26','zai-beta':'managed-agents-2026-09-22',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
    if(!r.ok){if(method==='DELETE'&&r.status===404)return {};throw new Fault(502,'bridge_api_'+r.status);}
    if(r.status===204)return {};
    if(raw){const text=await r.text();if(text.length>500000)throw new Fault(413,'meeting_artifact_too_large');return JSON.parse(text);}
    return r.json();
  };
  try{
    if(!env.PA_BRIDGE_DEPLOYMENT||!env.PA_BRIDGE_MEMORY||!env.PA_BIGMODEL_KEY)throw new Fault(503,'bridge_not_configured');
    const first=await ex.tick(undefined,env.PA_LEGACY_USER_ID);summary.processed+=first.processed;summary.synced+=first.synced;
    const runs=await request('deployment_runs?deployment_id='+encodeURIComponent(env.PA_BRIDGE_DEPLOYMENT)+'&limit=20');
    const seen=new Set();
    for(const run of (runs.data??[]).slice(0,20)){
      if(!run.session_id||run.error)continue;
      const files=[];let page;
      for(let n=0;n<10;n++){
        const result=await request('files?'+new URLSearchParams({scope_id:run.session_id,limit:'100',...(page?{page}:{})}));
        files.push(...(result.data??[]));if(!result.next_page)break;
        if(result.next_page===page||n===9)throw new Fault(502,'bridge_pagination_invalid');page=result.next_page;
      }
      const file=files.find(f=>(f.filename??f.name)==='meeting.json');if(!file)continue;
      const meeting=await request('files/'+encodeURIComponent(file.id)+'/content',{raw:true});
      const key=await hash(meeting.sourceOpenId+':'+meeting.externalId);
      if(seen.has(key))continue;seen.add(key);
      const sources=await p.store.all("SELECT * FROM pa_connections WHERE provider='feishu' AND status='connected'");
      const matches=sources.filter(c=>c.identity.id===meeting.sourceOpenId&&(!env.PA_LEGACY_USER_ID||c.user_id===env.PA_LEGACY_USER_ID)&&!c.credential);
      if(matches.length!==1)throw new Fault(409,'meeting_connector_not_active');
      await p.ingest(matches[0],meeting);
      // Only durable ingestion authorizes acknowledgment and artifact removal.
      const marker='/connector-'+key+'.txt',memoryPath='memory_stores/'+encodeURIComponent(env.PA_BRIDGE_MEMORY)+'/memories';
      try{await request(memoryPath,{method:'POST',body:{path:marker,content:'processed\n'}});}catch(error){
        if(error.code!=='bridge_api_409')throw error;
        // The same completed meeting can arrive again before its source
        // acknowledgment is observed. Verify the existing marker on conflict.
        let cursor,found=false;
        for(let n=0;n<100;n++){
          const existing=await request(memoryPath+'?'+new URLSearchParams({limit:'100',view:'full',...(cursor?{page:cursor}:{})}));
          if(existing.data?.some(m=>m.path===marker&&m.content?.trim()==='processed')){found=true;break;}
          if(!existing.next_page||existing.next_page===cursor)break;cursor=existing.next_page;
        }
        if(!found)throw error;
      }
      await request('files/'+encodeURIComponent(file.id),{method:'DELETE'});
      summary.ingested++;
      if(summary.ingested>=5)break;
    }
    const last=await ex.tick(undefined,env.PA_LEGACY_USER_ID);summary.processed+=last.processed;summary.synced+=last.synced;
    await p.store.receipt('scheduler-'+scheduledTime,'system',summary,'completed');
    await p.store.run("DELETE FROM pa_receipts WHERE user_id='system' AND id LIKE 'scheduler-%' AND updated_at<?",p.now()-30*86400000);
    console.log('connector_cron',JSON.stringify(summary));return summary;
  }catch(error){
    await p.store.receipt('scheduler-'+scheduledTime,'system',{...summary,error:error.code??'coordinator_failed'},'failed');
    throw error;
  }finally{await release();}
}
