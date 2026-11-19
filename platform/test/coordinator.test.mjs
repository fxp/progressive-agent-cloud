import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../../scripts/local-db.mjs';
import {Platform} from '../service.mjs';
import {coordinate} from '../coordinator.mjs';

for(const accepted of [true,false])test('Worker cron '+(accepted?'ingests once, acknowledges, records its round':'keeps a failed meeting unacknowledged'),async()=>{
  const env={DB:database(),PA_BRIDGE_ENABLED:'1',PA_BRIDGE_DEPLOYMENT:'exporter',PA_BRIDGE_MEMORY:'memory',PA_BIGMODEL_KEY:'test'};
  const p=new Platform(env);await p.store.connect({id:'source',user:'owner',provider:'feishu',kind:'meeting',identity:{id:'ou_test'}});
  const calls=[];let ingested=0,ticks=0;
  p.ingest=async()=>{ingested++;if(!accepted)throw Error('temporary model failure');return {taskIds:['task']};};
  const fetcher=async(url,options)=>{
    calls.push({url,method:options.method});
    if(url.includes('deployment_runs?'))return Response.json({data:[{session_id:'one'},{session_id:'two'}]});
    if(url.includes('/files?'))return Response.json({data:[{id:'file',filename:'meeting.json'}]});
    if(url.endsWith('/content'))return Response.json({sourceOpenId:'ou_test',externalId:'meeting',title:'Test',transcript:'Test'});
    return new Response(null,{status:204});
  };
  const execution={tick:async()=>{ticks++;return {synced:0,processed:0};}};
  const run=()=>coordinate(env,'',{platform:p,execution,fetcher,scheduledTime:123});
  if(accepted){const result=await run();assert.equal(result.ingested,1);assert.equal(ticks,2);}else await assert.rejects(run);
  assert.equal(ingested,1);
  assert.equal(calls.filter(c=>c.url.includes('/memories')).length,accepted?1:0);
  assert.equal(calls.filter(c=>c.method==='DELETE').length,accepted?1:0);
  const receipt=await p.store.one('SELECT * FROM pa_receipts WHERE id=?','scheduler-123');
  assert.equal(receipt.state,accepted?'completed':'failed');
  assert.equal(JSON.stringify(receipt).includes('transcript'),false);
  env.DB.raw.close();
});

test('Worker cron excludes an overlapping invocation',async()=>{
  const env={DB:database(),PA_BRIDGE_ENABLED:'1'},p=new Platform(env);
  const release=await p.store.lease('cloud-coordinator');
  assert.deepEqual(await coordinate(env,'',{platform:p}),{busy:true});
  await release();env.DB.raw.close();
});

test('an already acknowledged duplicate is removed without failing its cron round',async()=>{
  const env={DB:database(),PA_BRIDGE_ENABLED:'1',PA_BRIDGE_DEPLOYMENT:'exporter',PA_BRIDGE_MEMORY:'memory',PA_BIGMODEL_KEY:'test'};
  const p=new Platform(env);await p.store.connect({id:'source',user:'owner',provider:'feishu',kind:'meeting',identity:{id:'ou_test'}});
  p.ingest=async()=>({taskIds:['existing-task']});let marker,deleted=false;
  const fetcher=async(url,options)=>{
    if(url.includes('deployment_runs?'))return Response.json({data:[{session_id:'one'}]});
    if(url.includes('/files?'))return Response.json({data:[{id:'file',filename:'meeting.json'}]});
    if(url.endsWith('/content'))return Response.json({sourceOpenId:'ou_test',externalId:'meeting'});
    if(url.endsWith('/memories')){marker=JSON.parse(options.body).path;return Response.json({error:'conflict'},{status:409});}
    if(url.includes('/memories?'))return Response.json({data:[{path:marker,content:'processed\n'}]});
    if(options.method==='DELETE'){deleted=true;return new Response(null,{status:204});}
    throw Error('Unexpected API');
  };
  const summary=await coordinate(env,'',{platform:p,execution:{tick:async()=>({synced:0,processed:0})},fetcher,scheduledTime:456});
  assert.equal(summary.ingested,1);assert.equal(deleted,true);env.DB.raw.close();
});
