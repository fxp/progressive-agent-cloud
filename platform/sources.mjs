import {scanInbox} from './feishu-store.mjs';
import {Fault,hash} from './security.mjs';

// The cutoff never advances past late-indexed meetings. Search windows and
// page offsets survive retries; receipts scope every meeting to its owner.
export async function scanSource(p,connection){
  const user=connection.user_id;await p.agentKey(user);
  const current=await p.store.own('connections',connection.id,user);
  if(current.status!=='connected'||!current.credential)throw new Fault(409,'meeting_connector_not_active');
  if(current.identity.discovery==='events')return scanInbox(p,current);
  await p.store.run('INSERT OR IGNORE INTO pa_sources(connection_id,user_id,enrolled_at) VALUES(?,?,?)',connection.id,user,p.now());
  const source=await p.store.one('SELECT * FROM pa_sources WHERE connection_id=? AND user_id=?',connection.id,user);
  const cursor=JSON.parse(source.cursor);cursor.until??=p.now();cursor.offset??=0;
  const token=await p.access(current),since=Math.max(cursor.bootstrapDone?source.enrolled_at:0,p.now()-7*86400000);
  const page=await p.providers.meetings(token,current.identity.id,{since,until:cursor.until,pageToken:cursor.pageToken});
  let ingested=0,reads=0;
  for(let index=cursor.offset;index<page.items.length;index++){
    const item=page.items[index],key='meeting-'+await hash(connection.id+':'+item.externalId);
    const receipt=await p.store.one('SELECT state FROM pa_receipts WHERE id=? AND user_id=?',key,user);
    cursor.offset=index+1;
    if(receipt?.state==='completed'){
      if(!cursor.bootstrapDone){cursor.bootstrapDone=true;cursor.offset=0;delete cursor.until;delete cursor.pageToken;break;}
      continue;
    }
    let transcript;
    try{transcript=await p.providers.transcript(token,item.externalId);}catch(error){
      if(error.code==='transcript_not_ready'||/^feishu_api_209100[2-5]$/.test(error.code??'')){if(++reads>=5)break;continue;}
      throw error;
    }
    if(!transcript){if(++reads>=5)break;continue;}
    await p.ingest(current,{...item,sourceOpenId:current.identity.id,transcript});ingested++;
    if(!cursor.bootstrapDone){cursor.bootstrapDone=true;cursor.offset=0;delete cursor.until;delete cursor.pageToken;}
    // One model extraction per user job bounds latency and cost. The next
    // page offset remains durable; an empty round can skip many receipts.
    break;
  }
  if(cursor.offset>=page.items.length){cursor.offset=0;if(page.nextPage){if(page.nextPage===cursor.pageToken)throw new Fault(502,'invalid_pagination');cursor.pageToken=page.nextPage;}else{delete cursor.pageToken;delete cursor.until;}}
  await p.store.run('UPDATE pa_sources SET cursor=?,last_run_at=?,error=NULL WHERE connection_id=? AND user_id=?',JSON.stringify(cursor),p.now(),connection.id,user);
  await p.store.run('UPDATE pa_connections SET synced_at=?,error=NULL WHERE id=? AND user_id=?',p.now(),connection.id,user);
  return {ingested,discovered:page.items.length};
}
