import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {modelProxy} from '../runtime/model-proxy.mjs';

for(const protocol of ['responses','anthropic'])test(protocol+' proxy confines credentials, model, tool types and upstream destination',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pa-proxy-')),socket=join(dir,'model.sock'),calls=[];
 const proxy=await modelProxy({protocol,baseUrl:'https://gateway.example/fixed',model:'selected-model',apiKey:'real-upstream-secret'},socket,{fetcher:async(url,options)=>{calls.push({url,options});return new Response('data: {"ok":true}\n\n',{headers:{'content-type':'text/event-stream'}});}});
 const send=(path,body,auth=proxy.token)=>new Promise((resolve,reject)=>{const r=request({socketPath:socket,path,method:body?'POST':'GET',headers:{authorization:'Bearer '+auth,'content-type':'application/json'}},res=>{let body='';res.on('data',s=>body+=s);res.on('end',()=>resolve({status:res.statusCode,body}));});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});
 try{
  assert.equal((await send('/v1/models',undefined,'wrong')).status,401);
  const models=await send('/v1/models');assert.equal(models.status,200);assert.equal(models.body.includes('real-upstream-secret'),false);
  assert.equal((await send('/admin',{model:'override'})).status,404);
  const path=protocol==='responses'?'/v1/responses':'/v1/messages';
  assert.equal((await send(path,{tools:[{type:'web_search'}]})).status,400);
  assert.equal((await send(path,{tools:[{type:'namespace',name:'unsafe',tools:[{type:'web_search'}]}]})).status,400);
  const answer=await send(path,{model:'attacker-model',tools:[{type:'namespace',name:'local',tools:[{type:'function',name:'local_tool'}]}]});assert.equal(answer.status,200);assert.equal(answer.body.includes('real-upstream-secret'),false);assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://gateway.example/fixed'+(protocol==='responses'?'/responses':'/v1/messages'));assert.equal(JSON.parse(calls[0].options.body).model,'selected-model');assert.equal(calls[0].options.headers.authorization,'Bearer real-upstream-secret');assert.equal(calls[0].options.redirect,'error');
 }finally{await proxy.close();rmSync(dir,{recursive:true,force:true});}
});
