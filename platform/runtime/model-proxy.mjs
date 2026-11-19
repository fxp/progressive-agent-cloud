import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {chmodSync} from 'node:fs';

// Only this trusted host process knows the upstream credential. The coding
// container has no network and can reach this bounded model-only socket.
export async function modelProxy(credential,socket,{fetcher=fetch,diagnostic=()=>{}}={}){
 const token=randomBytes(32).toString('hex'),active=new Set();
 const server=createServer(async(req,res)=>{
  try{
   const supplied=(req.headers.authorization??'').replace(/^Bearer /,'')||req.headers['x-api-key']||'';
   if(Buffer.byteLength(supplied)!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){res.writeHead(401).end();return;}
   const path=new URL(req.url,'http://proxy').pathname;
   if(req.method==='GET'&&['/models','/v1/models'].includes(path)){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({object:'list',data:[{id:credential.model,object:'model',type:'model',display_name:credential.model,created_at:'2026-01-01T00:00:00Z'}]}));return;}
   const suffix=credential.protocol==='responses'?'/responses':'/v1/messages';
   if(req.method!=='POST'||!['/responses','/v1/responses','/messages','/v1/messages'].includes(path)||credential.protocol==='responses'&&!path.endsWith('/responses')||credential.protocol==='anthropic'&&!path.endsWith('/messages')){res.writeHead(404).end();return;}
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>4000000){res.writeHead(413).end();return;}chunks.push(chunk);}
   const input=JSON.parse(Buffer.concat(chunks));input.model=credential.model;
   diagnostic({event:'request',path,toolTypes:input.tools?.map(t=>t.type??'function')??[]});
   // Disable optional provider-managed tools; only local CLI tools are needed.
   const localTool=(t,depth=0)=>depth<8&&(t.type==='namespace'?Array.isArray(t.tools)&&t.tools.every(child=>localTool(child,depth+1)):['function','custom'].includes(t.type??'function'));
   if(input.tools?.some(t=>!localTool(t))){diagnostic({event:'tools_rejected'});res.writeHead(400,{'content-type':'application/json'}).end('{"error":{"message":"Unsupported provider-managed tool type"}}');return;}
   const abort=new AbortController();active.add(abort);
   try{
    const r=await fetcher(credential.baseUrl+suffix,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+credential.apiKey,'x-api-key':credential.apiKey,'anthropic-version':'2023-06-01',...(req.headers['anthropic-beta']?{'anthropic-beta':req.headers['anthropic-beta']} : {}),'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(180000)])});
    diagnostic({event:'upstream',status:r.status});
    res.writeHead(r.status,{'content-type':r.headers.get('content-type')??'application/json','cache-control':'no-store'});for await(const chunk of r.body??[])res.write(chunk);res.end();
   }finally{active.delete(abort);}
  }catch(error){diagnostic({event:'proxy_error',type:error.name});if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end('{"error":{"type":"gateway_error","message":"Model gateway request failed"}}');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});chmodSync(socket,0o600);
 return {token,async close(){for(const a of active)a.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
