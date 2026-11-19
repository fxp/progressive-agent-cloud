import {receiveFeishu} from './feishu-store.mjs';
import {startBootstrap,pollBootstrap,bootstrapOAuth} from './feishu-bootstrap.mjs';
import {Platform} from './service.mjs';
import {Execution} from './execution.mjs';
import {enqueueUser} from './scheduler.mjs';
import {rotateWebhook,webhookConnection,receiveMeeting,meetingStatus} from './meeting-webhook.mjs';
import {Fault,hash,random} from './security.mjs';
import {SESSION_COOKIE,PREAUTH_COOKIE,sessionFrom,preauthFrom,sessionCookie,preauthCookie,clearCookie,isSecureRequest,requireAllowedLogin} from './auth.mjs';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const redirect=(location,cookies=[])=>{const response=new Response(null,{status:302,headers:{location}});for(const cookie of cookies)response.headers.append('set-cookie',cookie);return response;};
async function body(request){
  if(!request.headers.get('content-type')?.includes('application/json'))throw new Fault(415,'json_required');
  if(Number(request.headers.get('content-length')??0)>1600000)throw new Fault(413,'request_too_large');
  const text=await request.text();if(text.length>1600000)throw new Fault(413,'request_too_large');
  try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid body');return value;}catch{throw new Fault(400,'invalid_json');}
}
export async function route(request,env,runnerSource,options={}){
  const url=new URL(request.url);let provider;
  try{
    const p=new Platform(env,options);const execution=new Execution(p,runnerSource);
    const path=url.pathname;
    const incoming=/^\/api\/webhooks\/meetings\/([\w-]+)(?:\/(inbound-[a-f0-9]{64}))?$/.exec(path);
    if(incoming){
      if(incoming[2]?request.method!=='GET':request.method!=='POST')throw new Fault(405,'method_not_allowed');
      const source=await webhookConnection(p,incoming[1],request.headers.get('authorization'));
      if(incoming[2])return json(await meetingStatus(p,source,incoming[2]));
      const result=await receiveMeeting(p,source,await body(request));
      await enqueueUser(p,source.user_id,{reason:'event'});
      return json(result,202);
    }
    if(path==='/api/webhooks/feishu'){
      const result=await receiveFeishu(request,p);
      if(result.challenge!==undefined)return json({challenge:result.challenge});
      await Promise.allSettled((result.users??[]).map(user=>enqueueUser(p,user,{reason:'event'})));
      return json({code:0});
    }
    if(path.startsWith('/api/runner/')){
      if(request.method!=='POST')throw new Fault(405,'method_not_allowed');
      const input=await body(request);
      const project=await execution.runnerProject(input.projectId,request.headers.get('authorization')?.replace(/^Bearer /,''));
      const action=path.slice('/api/runner/'.length);
      if(action==='tick')return json(await execution.tick(project.id));
      if(action==='meeting'){
        const source=await p.store.connection(project.user_id,'feishu');
        if(source?.status!=='connected'||source.identity.id!==input.sourceOpenId)throw new Fault(409,'meeting_connector_not_active');
        return json(await p.ingest(source,input));
      }
      if(!['claim','checkpoint','complete'].includes(action))throw new Fault(404,'not_found');
      return json(await execution[action](project,input));
    }
    if(path.startsWith('/api/service/')){
      if(request.method!=='POST')throw new Fault(405,'method_not_allowed');
      const token=request.headers.get('authorization')?.replace(/^Bearer /,'');
      if(!token||!env.PA_SERVICE_TOKEN||await hash(token)!==await hash(env.PA_SERVICE_TOKEN))throw new Fault(401,'service_unauthorized');
      if(path==='/api/service/tick')return json(await execution.tick());
      if(path==='/api/service/meetings'){
        const input=await body(request);
        const candidates=await p.store.all("SELECT * FROM pa_connections WHERE provider='feishu' AND status='connected'");
        const matches=candidates.filter(c=>c.identity.id===input.sourceOpenId);
        if(matches.length!==1)throw new Fault(409,'meeting_connector_not_active');
        return json(await p.ingest(matches[0],input));
      }
      throw new Fault(404,'not_found');
    }
    // Runner and service endpoints keep their own separate credentials and
    // are independent of the browser auth mode.
    const githubAuth=env.PA_AUTH_MODE==='github';
    const secure=isSecureRequest(request,env);
    let user=null,preauth=null;
    if(githubAuth){
      // GitHub mode never trusts oai-authenticated-user-id headers; identity
      // comes exclusively from the signed session cookie.
      const session=await sessionFrom(request,env);
      if(session)requireAllowedLogin(env,session.login);
      user=session?.user??null;
      preauth=await preauthFrom(request,env);
      if(path==='/api/logout'&&request.method==='POST'){
        if(request.headers.get('origin')!==env.PA_ORIGIN)throw new Fault(403,'origin_mismatch');
        const response=json({ok:true});
        response.headers.append('set-cookie',clearCookie(SESSION_COOKIE,{secure}));
        response.headers.append('set-cookie',clearCookie(PREAUTH_COOKIE,{secure}));
        return response;
      }
      if(!user){
        if(path==='/api/state'&&request.method==='GET')return json({error:'sign_in_required',loginUrl:'/api/oauth/github/start'},401);
        if(path==='/api/oauth/github/start'&&request.method==='GET'){
          // First login: PKCE OAuth bound to a signed, expiring preauth
          // cookie holding the pending user id.
          const pending=random();
          return redirect(await p.begin(pending,'github'),[await preauthCookie(pending,{secret:env.PA_SESSION_KEY,secure})]);
        }
        if(path==='/api/oauth/github/callback'&&request.method==='GET'){
          provider='github';
          if(!preauth)throw new Fault(401,'preauth_required');
          const connection=await p.callback(preauth.user,'github',url.searchParams,{useEnvConfig:true,deferSyncFailure:true,finalUser:async identity=>{requireAllowedLogin(env,identity.name);const id=`github:${identity.id}`;await p.register(id,identity.name);return id;}});
          return redirect(`${env.PA_ORIGIN}/app?connected=github${connection.syncError?'&error=project_sync_failed':''}`,[
            await sessionCookie({user:connection.user_id,login:connection.identity?.name??''},{secret:env.PA_SESSION_KEY,secure}),
            clearCookie(PREAUTH_COOKIE,{secure}),
          ]);
        }
        throw new Fault(401,'sign_in_required');
      }
      const account=await p.store.one('SELECT id FROM pa_users WHERE id=? AND disabled_at IS NULL',user);
      if(!account)throw new Fault(401,'sign_in_required');
    }else{
      user=request.headers.get('oai-authenticated-user-id');
    }
    if(!user)throw new Fault(401,'sign_in_required');
    if(request.method==='POST'&&request.headers.get('origin')!==env.PA_ORIGIN)throw new Fault(403,'origin_mismatch');
    if(path==='/api/state'&&request.method==='GET'){
      const state=await p.state(user);
      state.account=githubAuth?await p.store.one('SELECT id,login FROM pa_users WHERE id=?',user):null;
      state.projects=state.projects.map(project=>{
        if(!project.binding)return project;
        const {runnerCredential,runnerTokenHash,...binding}=project.binding;return {...project,binding};
      });return json(state);
    }
    let m;
    if(path==='/api/connectors/gitlab/token'&&request.method==='POST')return json(await p.saveGitlab(user,await body(request)));
    if(path==='/api/connectors/meeting-webhook/rotate'&&request.method==='POST')return json(await rotateWebhook(p,user));
    if(path==='/api/connectors/feishu/bootstrap/start'&&request.method==='POST')return json(await startBootstrap(p,user));
    if((m=/^\/api\/connectors\/feishu\/bootstrap\/([\w-]+)\/(poll|authorize)$/.exec(path))&&request.method==='POST'){
      const result=m[2]==='poll'?await pollBootstrap(p,user,m[1]):await bootstrapOAuth(p,user,m[1],await body(request));
      if(result.state==='completed'&&env.PA_USER_JOBS)await enqueueUser(p,user,{reason:'manual'});return json(result);
    }
    if((m=/^\/api\/meetings\/([A-Za-z0-9]{12,64})\/evidence$/.exec(path))&&request.method==='GET'){
      const source=await p.store.connection(user,'feishu');
      if(source?.status!=='connected'||source.identity.meetingContent!=='todos')throw new Fault(409,'meeting_connector_not_active');
      return json(await p.providers.todoEvidence(await p.access(source),m[1]));
    }
    if(path==='/api/meetings/recent'&&request.method==='GET'){
      const source=await p.store.connection(user,'feishu');
      if(source?.status!=='connected'||!source.credential)throw new Fault(409,'meeting_authorization_required');
      const cursor=await p.store.one('SELECT enrolled_at,last_run_at,error FROM pa_sources WHERE connection_id=? AND user_id=?',source.id,user);
      if(source.identity.discovery==='events'){const items=await p.store.all('SELECT minute_token AS externalId,title,url,state,error,received_at FROM pa_feishu_inbox WHERE connection_id=? AND user_id=? ORDER BY received_at DESC LIMIT 30',source.id,user);return json({items,hasMore:false,discovery:'events',source:cursor});}
      const until=p.now(),since=Math.max(url.searchParams.get('scope')==='new'?(cursor?.enrolled_at??until):0,until-7*86400000);
      const page=await p.providers.meetings(await p.access(source),source.identity.id,{since,until});
      return json({items:page.items,hasMore:!!page.nextPage,since,until,source:cursor});
    }
    if(path==='/api/check'&&request.method==='POST')return json(await enqueueUser(p,user,{reason:'manual'}));
    if(path==='/api/agents/bigmodel/settings'&&request.method==='POST'){
      await p.saveAgent(user,await body(request));const changed=await execution.refreshAgentSecrets(user);
      if(env.PA_USER_JOBS)await enqueueUser(p,user,{reason:'manual'});return json({saved:true,...changed});
    }
    if((m=/^\/api\/oauth\/(github|linear|feishu)\/(start|callback)$/.exec(path))&&request.method==='GET'){
      provider=m[1];
      const oauthOptions=provider==='feishu'&&url.searchParams.get('app')==='store'?{store:true}:{};
      if(githubAuth&&provider==='github')oauthOptions.finalUser=async identity=>{requireAllowedLogin(env,identity.name);return user;};
      if(m[2]==='start')return Response.redirect(await p.begin(user,provider,oauthOptions),302);
      await p.callback(user,provider,url.searchParams,oauthOptions);
      if(env.PA_USER_JOBS)await enqueueUser(p,user,{reason:'manual'});
      return Response.redirect(env.PA_ORIGIN+'/app?connected='+provider,302);
    }
    if((m=/^\/api\/connectors\/(github|linear|feishu)\/settings$/.exec(path))&&request.method==='POST'){
      await p.settings(user,m[1],await body(request));return json({saved:true});
    }
    if((m=/^\/api\/connectors\/([\w-]+)\/(sync|disconnect|activate)$/.exec(path))&&request.method==='POST'){
      if(m[2]==='activate'){await p.activate(user,m[1]);return json({connected:true});}
      if(m[2]==='disconnect'){await p.disconnect(user,m[1]);return json({disconnected:true});}
      const connection=await p.store.own('connections',m[1],user);
      if(connection.provider==='feishu')return json(await enqueueUser(p,user,{reason:'manual'}));
      return json({synced:await p.sync(user,m[1])});
    }
    if(path==='/api/repositories'&&request.method==='GET'){
      const conn=await p.store.own('connections',url.searchParams.get('connection'),user);
      if(conn.provider!=='github')throw new Fault(400,'github_connection_required');
      return json(await p.providers.repositories(await p.access(conn)));
    }
    if((m=/^\/api\/projects\/([\w-]+)\/(bind|install|unbind)$/.exec(path))&&request.method==='POST'){
      if(m[2]==='unbind'){await p.unbind(user,m[1]);return json({unbound:true});}
      const value=m[2]==='bind'?await p.bind(user,m[1],await body(request)):await execution.install(user,m[1]);
      if(env.PA_USER_JOBS)await enqueueUser(p,user,{reason:'manual'});
      const {runnerCredential,runnerTokenHash,...safe}=value;return json(safe);
    }
    if((m=/^\/api\/tasks\/([\w-]+)\/verification$/.exec(path))&&request.method==='GET')return json(await execution.verification(user,m[1]));
    if((m=/^\/api\/tasks\/([\w-]+)\/approve$/.exec(path))&&request.method==='POST'){
      await p.approve(user,m[1],await body(request));return json({queued:true});
    }
    throw new Fault(404,'not_found');
  }catch(error){
    if(!(error instanceof Fault))console.error('platform_unexpected',error?.name,String(error?.stack??'').split('\n').slice(1,4).join('\n'));
    const code=error instanceof Fault?error.code:'internal_error';
    if(provider&&url.pathname.endsWith('/callback'))return Response.redirect(env.PA_ORIGIN+'/app?error='+encodeURIComponent(code),302);
    return json({error:code},error instanceof Fault?error.status:500);
  }
}
