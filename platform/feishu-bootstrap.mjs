import {Fault,hash,seal,open,b64} from './security.mjs';

// Wire protocol documented by the official SDK's registerApp implementation.
// Each bounded HTTP poll survives browser/Worker restarts; no local daemon.
const registration='https://accounts.feishu.cn/oauth/v1/app/registration';
export const bootstrapUserScopes=['minutes:minutes.basic:read','minutes:minutes.search:read','minutes:minutes.transcript:export','offline_access'];
export const todoUserScopes=['minutes:minutes.basic:read','minutes:minutes.search:read','minutes:minutes.artifacts:read','offline_access'];
const setupContext=id=>'feishu-setup:'+id;
const safe=(row,payload)=>({id:row.id,state:row.state,error:row.error,expiresAt:row.expires_at,nextPollAt:row.next_poll_at,...(payload?.config?{appId:payload.config.clientId,readingMode:payload.config.meetingContent??'transcript'}:{}),...(payload?.approvalScopes?{missingScopes:payload.approvalScopes}:{}),...(payload&&['pending','user_authorizing'].includes(row.state)?{verificationUrl:row.state==='pending'?payload.verificationUrl:payload.deviceAuth?.verificationUrl}:{})});
async function request(p,url,body,method='POST',token){
 const form=body instanceof URLSearchParams;
 const r=await p.fetch(url,{method,headers:{'content-type':form?'application/x-www-form-urlencoded':'application/json',...(token?{authorization:token}:{})},body:form?body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 let result;try{result=await r.json();}catch{throw new Fault(502,'feishu_bootstrap_response_invalid');}
 if(result.error)return result;
 if(!r.ok||result.code)throw new Fault(502,'feishu_config_api_'+(Number(result.code)||r.status));
 return result;
}
async function own(p,user,id){const row=await p.store.one('SELECT * FROM pa_feishu_setups WHERE id=? AND user_id=?',id,user);if(!row)throw new Fault(404,'not_found');return row;}
async function read(p,row){return open(p.env.PA_ENCRYPTION_KEY,row.credential,setupContext(row.id));}
async function save(p,row,payload,state,error=null){
 await p.store.run('UPDATE pa_feishu_setups SET credential=?,state=?,error=?,next_poll_at=?,updated_at=? WHERE id=? AND user_id=?',payload?await seal(p.env.PA_ENCRYPTION_KEY,payload,setupContext(row.id)):null,state,error,p.now()+5000,p.now(),row.id,row.user_id);
 return own(p,row.user_id,row.id);
}
export async function startBootstrap(p,user){
 const id='setup-'+await hash(user),release=await p.store.lease('bootstrap:'+id,45000);
 try{
  let row=await p.store.one('SELECT * FROM pa_feishu_setups WHERE user_id=?',user);
  if(row&&(!['pending','expired','denied'].includes(row.state)||row.state==='pending'&&row.expires_at>p.now())){
   const value=row.credential?await read(p,row):{};
   if(row.state==='blocked'&&value.token)return await advanceDevice(p,row,value);
   return {...safe(row,value),verificationUrl:row.state==='pending'?value.verificationUrl:row.state==='user_authorizing'?value.deviceAuth?.verificationUrl:null};
  }
  const result=await request(p,registration,new URLSearchParams({action:'begin',archetype:'PersonalAgent',auth_method:'client_secret',request_user_info:'open_id'}));
  if(result.error||typeof result.device_code!=='string'||!result.device_code||typeof result.verification_uri_complete!=='string')throw new Fault(502,'feishu_bootstrap_start_failed');
  const url=new URL(result.verification_uri_complete);if(url.protocol!=='https:'||!['accounts.feishu.cn','open.feishu.cn'].includes(url.hostname)||url.username||url.password)throw new Fault(502,'feishu_bootstrap_url_invalid');
  const addons={preset:false,scopes:{user:todoUserScopes}};
  const compressed=await new Response(new Blob([JSON.stringify(addons)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  url.searchParams.set('addons',b64(new Uint8Array(compressed)).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''));
  url.searchParams.set('from','sdk');url.searchParams.set('source','node-sdk/progressive-agent');url.searchParams.set('tp','sdk');url.searchParams.set('createOnly','true');
  url.searchParams.set('name','Progressive Agent · {user}');url.searchParams.set('desc','自动读取本人可访问的新妙记，匹配绑定的项目，由云端 Agent 开发、测试、创建草稿 PR 并回填。');
  const ttl=Math.min(Math.max(Number(result.expires_in)||600,30),1800)*1000,interval=Math.min(Math.max(Number(result.interval)||5,5),60)*1000;
  const payload={deviceCode:result.device_code,verificationUrl:url.href,interval};
  await p.store.run('INSERT INTO pa_feishu_setups VALUES(?,?,?,?,?,?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,credential=excluded.credential,expires_at=excluded.expires_at,next_poll_at=excluded.next_poll_at,error=NULL,updated_at=excluded.updated_at',id,user,'pending',await seal(p.env.PA_ENCRYPTION_KEY,payload,setupContext(id)),p.now()+ttl,p.now()+interval,p.now());
  row=await own(p,user,id);return {...safe(row),verificationUrl:url.href};
 }finally{await release();}
}
export async function pollBootstrap(p,user,id){
 const release=await p.store.lease('bootstrap:'+id,45000);
 try{
  let row=await own(p,user,id);
  if(['ready','completed','expired','denied','awaiting_approval'].includes(row.state))return safe(row,row.credential?await read(p,row):undefined);
  if(row.next_poll_at>p.now())return safe(row,await read(p,row));
  if(row.state==='pending'&&row.expires_at<=p.now())return safe(await save(p,row,null,'expired','feishu_bootstrap_expired'));
  const payload=await read(p,row);
  if(row.state==='user_authorizing')return await advanceDevice(p,row,payload);
  if(row.state==='pending'){
   const result=await request(p,registration,new URLSearchParams({action:'poll',device_code:payload.deviceCode}));
   if(result.user_info?.tenant_brand==='lark')return safe(await save(p,row,null,'denied','feishu_bootstrap_lark_unsupported'));
   if(['authorization_pending','slow_down'].includes(result.error)){
    if(result.error==='slow_down')payload.interval=Math.min(payload.interval+5000,60000);
    await p.store.run('UPDATE pa_feishu_setups SET next_poll_at=?,credential=? WHERE id=?',p.now()+payload.interval,await seal(p.env.PA_ENCRYPTION_KEY,payload,setupContext(id)),id);return safe(await own(p,user,id),payload);
   }
   if(result.error)return safe(await save(p,row,null,result.error==='expired_token'?'expired':'denied',result.error==='expired_token'?'feishu_bootstrap_expired':'feishu_bootstrap_denied'));
   if(!/^cli_[A-Za-z0-9]+$/.test(result.client_id??'')||typeof result.client_secret!=='string'||!result.client_secret||!result.user_info?.open_id)throw new Fault(502,'feishu_bootstrap_response_invalid');
   // Persist the one-time result BEFORE any configuration API call can fail.
   payload.config={clientId:result.client_id,clientSecret:result.client_secret,scope:todoUserScopes.join(' '),meetingContent:'todos',tokenVersion:'v3',appType:'custom',bootstrap:{setupId:id,openId:result.user_info.open_id}};
   delete payload.deviceCode;delete payload.verificationUrl;
   row=await save(p,row,payload,'configuring');
  }
  return safe(await save(p,row,payload,'ready'),payload);
 }finally{await release();}
}
export async function bootstrapOAuth(p,user,id,options={}){
 const release=await p.store.lease('bootstrap:'+id,45000);
 try{
  const row=await own(p,user,id);if(!['ready','completed','blocked','user_authorizing','awaiting_approval'].includes(row.state))throw new Fault(409,'feishu_bootstrap_not_ready');
  const payload=await read(p,row),config=payload.config;
  const mode=options.mode??config.meetingContent??'transcript';if(!['transcript','todos'].includes(mode))throw new Fault(400,'feishu_reading_mode_invalid');
  const scopes=mode==='todos'?todoUserScopes:bootstrapUserScopes;
  if(payload.deviceAuth?.expiresAt>p.now()&&row.state==='user_authorizing'&&mode===(config.meetingContent??'transcript'))return {...safe(row,payload),verificationUrl:payload.deviceAuth.verificationUrl};
  const result=await request(p,'https://accounts.feishu.cn/oauth/v1/device_authorization',new URLSearchParams({client_id:config.clientId,scope:scopes.join(' ')}),'POST','Basic '+btoa(config.clientId+':'+config.clientSecret));
  if(result.error)throw new Fault(409,'feishu_device_'+String(result.error).replace(/[^a-zA-Z0-9_]/g,'').slice(0,80));
  const url=new URL(result.verification_uri_complete??result.verification_uri);if(url.protocol!=='https:'||!['accounts.feishu.cn','open.feishu.cn'].includes(url.hostname)||!result.device_code)throw new Fault(502,'feishu_bootstrap_response_invalid');
  payload.config={...config,scope:scopes.join(' '),tokenVersion:'v3',meetingContent:mode};
  payload.deviceAuth={code:result.device_code,verificationUrl:url.href,expiresAt:p.now()+Math.min(Number(result.expires_in)||240,1800)*1000,interval:Math.max(Number(result.interval)||5,5)*1000};delete payload.token;delete payload.approvalScopes;
  const saved=await save(p,row,payload,'user_authorizing');return {...safe(saved,payload),verificationUrl:url.href};
 }finally{await release();}
}
async function advanceDevice(p,row,payload){
 const device=payload.deviceAuth,config=payload.config;
 if(!payload.token){
  if(!device||device.expiresAt<=p.now())return safe(await save(p,row,payload,'blocked','feishu_device_expired'));
  const result=await request(p,'https://accounts.feishu.cn/oauth/v3/token',new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.code,client_id:config.clientId,client_secret:config.clientSecret}));
  if(['authorization_pending','slow_down'].includes(result.error)){
   if(result.error==='slow_down')device.interval=Math.min(device.interval+5000,60000);
   const saved=await save(p,row,payload,'user_authorizing');await p.store.run('UPDATE pa_feishu_setups SET next_poll_at=? WHERE id=?',p.now()+device.interval,row.id);return safe({...saved,next_poll_at:p.now()+device.interval},payload);
  }
  if(result.error)return safe(await save(p,row,payload,'blocked','feishu_device_'+String(result.error).replace(/[^a-zA-Z0-9_]/g,'').slice(0,80)));
  if(!result.access_token)throw new Fault(502,'feishu_bootstrap_response_invalid');
  payload.token={...result,expiresAt:p.now()+Number(result.expires_in??7200)*1000};
  row=await save(p,row,payload,'user_authorizing');
 }
 try{
  if(typeof payload.token.scope!=='string')throw new Fault(502,'feishu_bootstrap_scope_unverified');
  const granted=payload.token.scope.split(/[\s,]+/),missing=config.scope.split(/\s+/).filter(scope=>!granted.includes(scope));
  if(missing.length){payload.approvalScopes=missing;throw new Fault(409,'feishu_minutes_approval_required');}
  await p.acceptFeishu(row.user_id,payload.token,config,{expectedFeishuOpenId:config.bootstrap.openId,replaceConnection:true});
  delete payload.token;delete payload.deviceAuth;return safe(await save(p,row,payload,'completed'),payload);
 }catch(error){
  const approval=error.code==='feishu_minutes_approval_required';
  if(approval||error.code==='feishu_offline_scope_required'){delete payload.token;delete payload.deviceAuth;}
  return safe(await save(p,row,payload,approval?'awaiting_approval':'blocked',error instanceof Fault?error.code:'feishu_bootstrap_connection_failed'),payload);
 }
}
