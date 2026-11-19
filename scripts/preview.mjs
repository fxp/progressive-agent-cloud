import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {route} from '../platform/http.mjs';
import {database} from './local-db.mjs';
const port=Number(process.env.PORT||4176),origin='http://127.0.0.1:'+port;
mkdirSync('.local',{recursive:true});
let key;try{key=readFileSync('.local/preview-key','utf8');}catch{key=randomBytes(32).toString('base64');writeFileSync('.local/preview-key',key,{mode:0o600});}
const env={DB:database('.local/preview.sqlite'),PA_ORIGIN:origin,PA_ENCRYPTION_KEY:key,...Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('PA_')))};
const {runnerSource:runner}=await import('../worker/assets.generated.mjs');
createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','local-preview-owner');
  const request=new Request(origin+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
  let response;
  if(req.url.startsWith('/api/'))response=await route(request,env,runner);
  else{
   let path=new URL(request.url).pathname;if(path==='/')path='/index.html';if(path==='/app'||path==='/app/')path='/app/index.html';
   const filename=resolve('dist','.'+path);
   if(!filename.startsWith(resolve('dist')+'/')){res.writeHead(403).end();return;}
   const bytes=readFileSync(filename);
   response=new Response(bytes,{headers:{'content-type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.md':'text/markdown; charset=utf-8'})[extname(path)]||'text/plain'}});
  }
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(e){res.writeHead(e.code==='ENOENT'?404:500).end('Preview request failed');}
}).listen(port,'127.0.0.1',()=>console.log('Local: '+origin+'/app (development identity only)'));
