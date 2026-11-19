import {Fault,hash,random,seal,open} from './security.mjs';

const provider='meeting-webhook';
export async function rotateWebhook(p,user){
 const previous=await p.store.connection(user,provider),id=provider+'-'+await hash(user),token=random();
 await p.store.connect({id,user,provider,kind:'meeting',identity:{id,name:'会议纪要 Webhook',enrolledAt:previous?.status==='connected'?previous.identity.enrolledAt:p.now()},credential:await seal(p.env.PA_ENCRYPTION_KEY,{tokenHash:await hash(token)},id)});
 return {connectionId:id,url:p.env.PA_ORIGIN+'/api/webhooks/meetings/'+id,token};
}
export function webhookMeeting(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Fault(400,'invalid_meeting');
 const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
 if(!text(value.externalId,200)||!text(value.title,500)||!Array.isArray(value.todos)||!value.todos.length||value.todos.length>100||!Array.isArray(value.notes)||value.notes.length>100)throw new Fault(400,'meeting_evidence_required');
 if(value.url!==undefined&&(typeof value.url!=='string'||value.url.length>2000||!/^https:\/\//.test(value.url)))throw new Fault(400,'invalid_meeting_url');
 const todos=value.todos.map(t=>{if(!t||!text(t.id,200)||!text(t.content,6000))throw new Fault(400,'invalid_todo');return {id:t.id,content:t.content};});
 const notes=value.notes.map(n=>{if(!n||!text(n.id,200)||n.id.startsWith('todo:')||!['summary','chapter'].includes(n.kind)||!text(n.text,70000)||(n.title!==undefined&&!text(n.title,500)))throw new Fault(400,'invalid_note');return {id:n.id,kind:n.kind,text:n.text,...(n.title?{title:n.title}:{})};});
 if(new Set(todos.map(t=>t.id)).size!==todos.length||new Set(notes.map(n=>n.id)).size!==notes.length||JSON.stringify({todos,notes}).length>100000)throw new Fault(400,'invalid_meeting_evidence');
 // Neither caller-supplied criteria, project IDs nor approval flags cross this boundary.
 return {externalId:value.externalId,title:value.title,url:value.url??'',transcript:todos.map(t=>t.content).join('\n\n'),sourceKind:'meeting_todos',sourceTodos:todos,sourceTodoIds:todos.map(t=>t.id),sourceNotes:notes};
}
export async function webhookConnection(p,id,authorization){
 const connection=await p.store.one("SELECT * FROM pa_connections WHERE id=? AND provider=? AND status='connected'",id,provider);
 const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization??'')?.[1];
 if(!connection||!token)throw new Fault(401,'webhook_unauthorized');
 const {tokenHash}=await open(p.env.PA_ENCRYPTION_KEY,connection.credential,connection.id);
 if(await hash(token)!==tokenHash)throw new Fault(401,'webhook_unauthorized');
 const account=await p.store.one('SELECT id FROM pa_users WHERE id=? AND disabled_at IS NULL',connection.user_id);
 if(!account)throw new Fault(401,'webhook_unauthorized');
 return connection;
}
export async function receiveMeeting(p,connection,value){
 const meeting=webhookMeeting(value),id='inbound-'+await hash(connection.id+':'+meeting.externalId),digest=await hash(JSON.stringify(meeting));
 const inserted=await p.store.run("INSERT INTO pa_receipts VALUES(?,?,?,'queued',?) ON CONFLICT(id) DO NOTHING",id,connection.user_id,JSON.stringify({connectionId:connection.id,digest,meeting,receivedAt:p.now()}),p.now());
 const receipt=await p.store.one('SELECT * FROM pa_receipts WHERE id=? AND user_id=?',id,connection.user_id);
 if(receipt.payload.digest!==digest)throw new Fault(409,'meeting_event_conflict');
 return {eventId:id,state:receipt.state,duplicate:!inserted.meta.changes};
}
export async function drainMeetings(p,user){
 const connection=await p.store.connection(user,provider);if(connection?.status!=='connected')return {webhookMeetings:0};
 const rows=await p.store.all("SELECT * FROM pa_receipts WHERE user_id=? AND id LIKE 'inbound-%' AND state='queued' ORDER BY updated_at LIMIT 5",user);
 let count=0;
 for(const row of rows){
  if(row.payload.connectionId!==connection.id)continue;
  if(row.payload.receivedAt<connection.identity.enrolledAt){await p.store.receipt(row.id,user,row.payload,'cancelled');continue;}
  // ingest's durable meeting receipt recovers safely after interruption here.
  const meeting=await p.registry.get(connection.provider,'meeting').read({platform:p},connection,row.payload);
  const result=await p.ingest(connection,meeting);
  await p.store.receipt(row.id,user,{...row.payload,taskIds:result.taskIds},'completed');count++;
 }
 return {webhookMeetings:count};
}
export async function meetingStatus(p,connection,eventId){
 const row=await p.store.one('SELECT * FROM pa_receipts WHERE id=? AND user_id=?',eventId,connection.user_id);
 if(!row||row.payload.connectionId!==connection.id)throw new Fault(404,'not_found');
 const tasks=[];
 for(const id of row.payload.taskIds??[]){const t=await p.store.own('tasks',id,connection.user_id);tasks.push({id,status:t.status,projectId:t.project_id,title:t.payload.title,clarificationReason:t.payload.clarificationReason??t.payload.projectClarificationReason??null,original:t.payload.original??null,result:t.payload.result??null});}
 return {eventId:row.id,state:row.state,tasks};
}
