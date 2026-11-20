import {route} from '../platform/http.mjs';
import {assets,runnerSource} from './assets.generated.mjs';
import {schedule,consume} from '../platform/scheduler.mjs';
export default {
  async scheduled(controller,env){await schedule(env,runnerSource,{scheduledTime:controller.scheduledTime});},
  async queue(batch,env){await consume(batch,env,runnerSource);},
  async fetch(request,env){
    const url=new URL(request.url),path=url.pathname;
    // Keep browser navigation on the canonical OAuth/cookie origin. Existing
    // server clients retain their own authentication: cross-origin redirects
    // can strip their Authorization header during a domain migration.
    const service=path.startsWith('/api/runner/')||path.startsWith('/api/service/')||path.startsWith('/api/webhooks/');
    if(!service&&env.PA_AUTH_MODE==='github'&&env.PA_ORIGIN&&url.origin!==env.PA_ORIGIN){
      return Response.redirect(env.PA_ORIGIN+path+url.search,307);
    }
    if(path.startsWith('/api/'))return route(request,env,runnerSource);
    const resource=assets[path==='/'?'/index.html':path==='/app'||path==='/app/'?'/app/index.html':path==='/invite'||path==='/invite/'?'/invite/index.html':path];
    if(!resource)return new Response('Not found',{status:404});
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    return new Response(request.method==='HEAD'?null:resource.body,{headers:{'content-type':resource.type,'x-content-type-options':'nosniff','referrer-policy':'same-origin','cache-control':path.startsWith('/app')?'no-store':'public, max-age=60'}});
  },
};
