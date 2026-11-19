import {release} from './release.mjs';
export async function health(p){
 let database=false;try{await p.store.one('SELECT id FROM pa_invites LIMIT 1');database=true;}catch{}
 const key=value=>{try{return atob(value??'').length===32;}catch{return false;}};
 const configuration=p.env.PA_AUTH_MODE==='github'&&/^https:\/\//.test(p.env.PA_ORIGIN??'')&&key(p.env.PA_SESSION_KEY)&&key(p.env.PA_ENCRYPTION_KEY)&&!!p.env.PA_GITHUB_CLIENT_ID&&!!p.env.PA_GITHUB_CLIENT_SECRET&&(p.env.PA_SIGNUP_MODE==='open'||!!p.env.PA_ADMIN_USER_IDS?.trim());
 const queue=typeof p.env.PA_USER_JOBS?.send==='function',ok=database&&configuration&&queue;
 return {status:ok?'ok':'degraded',...release,registration:p.env.PA_SIGNUP_MODE==='open'?'open':'invite',components:{database,configuration,queue}};
}
