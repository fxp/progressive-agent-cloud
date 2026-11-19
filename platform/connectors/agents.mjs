import {Fault,open} from '../security.mjs';

const publicURL=value=>{let u;try{u=new URL(value);}catch{throw new Fault(400,'invalid_agent_endpoint');}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Fault(400,'invalid_agent_endpoint');return u.href.replace(/\/$/,'');};
export const agentManifests=[
 {id:'bigmodel',kind:'agent',name:'BigModel Managed Agent',icon:'B',description:'隔离云端沙箱开发，生成可独立验证的补丁',auth:'api_key',capabilities:['execute','resume','patch','reasoning']},
 {id:'codex',kind:'agent',name:'Codex CLI',icon:'C',description:'在隔离云端容器运行 Codex；可连接兼容模型网关',auth:'api_key',capabilities:['execute','resume','patch']},
 {id:'claude-code',kind:'agent',name:'Claude Code',icon:'A',description:'在隔离云端容器运行 Claude Code；可连接兼容模型网关',auth:'api_key',capabilities:['execute','resume','patch']},
];
export function agentPlugin(manifest){
 const id=manifest.id;
 return {manifest:{...manifest,apiVersion:1,roles:['agent']},agent:{
  async validate({platform:p},input){
   const apiKey=String(input.apiKey??'').trim();if(apiKey.length<10||apiKey.length>4096||/\s/.test(apiKey))throw new Fault(400,'agent_key_invalid');
   const defaults={bigmodel:'https://agent-api.bigmodel.cn/api/agent/managed/v1',codex:'https://api.openai.com/v1','claude-code':'https://api.anthropic.com'};
   const baseUrl=publicURL(input.baseUrl||defaults[id]);
   const allowed=new Set(['agent-api.bigmodel.cn','api.openai.com','api.anthropic.com','open.bigmodel.cn',...(p.env.PA_AGENT_ALLOWED_HOSTS??'').split(',').map(s=>s.trim()).filter(Boolean)]);
   if(!allowed.has(new URL(baseUrl).hostname))throw new Fault(400,'agent_endpoint_not_allowed');
   const protocol=input.protocol??(id==='bigmodel'?'managed':id==='codex'?'responses':'anthropic');
   if(protocol!==({bigmodel:'managed',codex:'responses','claude-code':'anthropic'})[id])throw new Fault(400,'agent_protocol_invalid');
   const model=String(input.model??'').trim();if(model.length>160||/[\r\n\x00]/.test(model))throw new Fault(400,'agent_model_invalid');
   if(id!=='bigmodel'&&!model)throw new Fault(400,'agent_model_required');
   const headers={authorization:'Bearer '+apiKey,...(id==='claude-code'&&protocol==='anthropic'?{'x-api-key':apiKey,'anthropic-version':'2023-06-01'}:{})};
   const url=baseUrl+(id==='bigmodel'?'/agents?limit=1':protocol==='anthropic'?'/v1/messages':protocol==='responses'?'/responses':'/chat/completions');
   const probe=id==='bigmodel'?undefined:protocol==='responses'?{model,input:'Reply OK.',max_output_tokens:16}:{model,max_tokens:16,messages:[{role:'user',content:'Reply OK.'}]};
   const r=await p.fetch(url,{method:probe?'POST':'GET',headers:{...headers,...(probe?{'content-type':'application/json'}:{})},body:probe?JSON.stringify(probe):undefined,redirect:'manual',signal:AbortSignal.timeout(30000)});
   if(!r.ok)throw new Fault(r.status===401||r.status===403?401:502,'agent_key_rejected');
   return {apiKey,baseUrl,protocol,model};
  },
  async credential({platform:p},connection){
   if(connection?.status!=='connected')throw new Fault(409,'agent_not_connected');
   if(connection.credential)return open(p.env.PA_ENCRYPTION_KEY,connection.credential,connection.id);
   if(id==='bigmodel')return {apiKey:await p.agentKey(connection.user_id),protocol:'managed'};
   throw new Fault(409,'agent_key_missing');
  },
  async completeJSON(ctx,connection,request){
   const p=ctx.platform,c=await this.credential(ctx,connection),protocol=c.protocol??(id==='bigmodel'?'managed':id==='codex'?'responses':'anthropic');
   const system=request.system,user=request.content;let url,body,headers={authorization:'Bearer '+c.apiKey,'content-type':'application/json'};
   if(protocol==='managed'||protocol==='bigmodel-chat'){
    url=protocol==='managed'?'https://open.bigmodel.cn/api/paas/v4/chat/completions':c.baseUrl+'/chat/completions';
    body={model:protocol==='managed'?'glm-4.6':c.model,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:request.maxTokens,messages:[{role:'system',content:system},{role:'user',content:user}]};
   }else if(protocol==='responses'){
    url=c.baseUrl+'/responses';body={model:c.model,instructions:system,input:user,max_output_tokens:request.maxTokens,text:{format:{type:'json_object'}}};
   }else{
    url=c.baseUrl+'/v1/messages';headers={...headers,'x-api-key':c.apiKey,'anthropic-version':'2023-06-01'};body={model:c.model,system,max_tokens:request.maxTokens,messages:[{role:'user',content:user}]};
   }
   const r=await p.fetch(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(60000)});
   if(!r.ok)throw new Fault(502,'requirement_review_unavailable');const result=await r.json();let text;
   if(protocol==='managed'||protocol==='bigmodel-chat'){if(result.choices?.[0]?.finish_reason!=='stop')throw new Fault(502,'requirement_review_incomplete');text=result.choices[0].message.content;}
   else if(protocol==='responses'){if(result.status!=='completed')throw new Fault(502,'requirement_review_incomplete');text=result.output?.filter(o=>o.type==='message').flatMap(o=>o.content??[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');}
   else {if(result.stop_reason!=='end_turn')throw new Fault(502,'requirement_review_incomplete');text=result.content?.filter(c=>c.type==='text').map(c=>c.text).join('');}
   try{return JSON.parse(text);}catch{throw new Fault(502,'requirement_review_invalid');}
  },
  execution(){return {id,runtime:id==='bigmodel'?'managed':'cli',...(id==='codex'?{package:'@openai/codex@0.170.0',binary:'codex'}:id==='claude-code'?{package:'@anthropic-ai/claude-code@2.1.328',binary:'claude'}:{})};},
 }};
}
