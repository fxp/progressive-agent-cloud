import {route} from '../platform/http.mjs';
import {assets,runnerSource} from './assets.generated.mjs';
import {schedule,consume} from '../platform/scheduler.mjs';
export default {
  async scheduled(controller,env){await schedule(env,runnerSource,{scheduledTime:controller.scheduledTime});},
  async queue(batch,env){await consume(batch,env,runnerSource);},
  async fetch(request,env){
    const url=new URL(request.url),path=url.pathname;
    // OAuth cookies must stay on the registered callback host. Additional
    // public domains serve the landing page and forward workbench access.
    if(path!=='/api/webhooks/feishu'&&env.PA_AUTH_MODE==='github'&&env.PA_ORIGIN&&url.origin!==env.PA_ORIGIN&&(path.startsWith('/api/')||path==='/app'||path.startsWith('/app/'))){
      return Response.redirect(env.PA_ORIGIN+path+url.search,307);
    }
    if(path.startsWith('/api/'))return route(request,env,runnerSource);
    const resource=assets[path==='/'?'/index.html':path==='/app'||path==='/app/'?'/app/index.html':path];
    if(!resource)return new Response('Not found',{status:404});
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    return new Response(request.method==='HEAD'?null:resource.body,{headers:{'content-type':resource.type,'x-content-type-options':'nosniff','referrer-policy':'same-origin','cache-control':path.startsWith('/app')?'no-store':'public, max-age=60'}});
  },
};
