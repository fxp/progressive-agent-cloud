import {Fault,hash,random} from './security.mjs';
import {loginAllowed,preauthCookie} from './auth.mjs';

export const isAdmin=(env,user)=>env.PA_AUTH_MODE==='github'&&(env.PA_ADMIN_USER_IDS??'').split(',').map(x=>x.trim()).filter(Boolean).includes(user);
export function requireAdmin(p,user){if(!isAdmin(p.env,user))throw new Fault(403,'admin_required');}
export async function requireAdmission(p,user,login){
 if(isAdmin(p.env,user)||loginAllowed(p.env,login))return;
 const member=await p.store.one('SELECT user_id FROM pa_beta_members WHERE user_id=? AND revoked_at IS NULL',user);
 if(!member)throw new Fault(403,'github_login_not_allowed');
}
export async function accountEnabled(p,user){
 if(p.env.PA_AUTH_MODE!=='github')return true;
 const account=await p.store.one('SELECT id,login,disabled_at FROM pa_users WHERE id=?',user);
 if(!account||account.disabled_at!==null)return false;
 try{await requireAdmission(p,user,account.login);return true;}catch(error){if(error.code==='github_login_not_allowed')return false;throw error;}
}
const tokenHash=async token=>{if(typeof token!=='string'||!/^[-\w]{43}$/.test(token))throw new Fault(404,'invitation_unavailable');return hash(token);};
async function available(p,digest){
 const invite=await p.store.one('SELECT * FROM pa_invites WHERE token_hash=?',digest);
 if(!invite||invite.revoked_at!==null||invite.expires_at<=p.now()||invite.accepted_at!==null)throw new Fault(410,'invitation_unavailable');return invite;
}
const view=(r,now)=>({id:r.id,login:r.login,githubId:r.github_id,createdAt:r.created_at,expiresAt:r.expires_at,acceptedAt:r.accepted_at,acceptedUserId:r.accepted_user_id,status:r.revoked_at!==null?'revoked':r.accepted_at!==null?'accepted':r.expires_at<=now?'expired':'pending'});

export async function listInvites(p,user){requireAdmin(p,user);return (await p.store.all('SELECT * FROM pa_invites ORDER BY created_at DESC LIMIT 100')).map(r=>view(r,p.now()));}
export async function createInvite(p,user,input){
 requireAdmin(p,user);
 const login=String(input.login??'').trim(),days=input.days??7;
 if(!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(login)||!Number.isInteger(days)||days<1||days>30)throw new Fault(400,'invalid_invitation');
 const connection=await p.store.connection(user,'github');if(!connection?.credential||['disconnected','needs_auth'].includes(connection.status))throw new Fault(409,'github_connection_required');
 const target=await p.providers.gh(await p.access(connection),'/users/'+encodeURIComponent(login));
 if(!/^\d+$/.test(String(target.id??''))||typeof target.login!=='string')throw new Fault(502,'invitation_account_unverified');
 const token=random(),id='invite-'+random(),now=p.now();
 await p.store.run('INSERT INTO pa_invites(id,token_hash,github_id,login,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',id,await hash(token),String(target.id),target.login,user,now,now+days*86400000);
 return {invite:view(await p.store.one('SELECT * FROM pa_invites WHERE id=?',id),now),url:p.env.PA_ORIGIN+'/invite#'+token};
}
export async function inspectInvite(p,token){const invite=await available(p,await tokenHash(token));return {login:invite.login,expiresAt:invite.expires_at};}
export async function startInvite(p,token,{secure}){
 const digest=await tokenHash(token);await available(p,digest);
 const pending={user:random(),inviteHash:digest};
 return {url:await p.begin(pending.user,'github'),cookie:await preauthCookie(pending,{secret:p.env.PA_SESSION_KEY,secure,now:p.now()})};
}
export async function admitLogin(p,identity,inviteHash){
 const user='github:'+identity.id;
 if(!inviteHash){await requireAdmission(p,user,identity.name);await p.register(user,identity.name);return user;}
 const invite=await available(p,inviteHash);
 if(invite.github_id!==String(identity.id))throw new Fault(403,'invitation_account_mismatch');
 const claim=random(),now=p.now();
 // Redemption and admission share one atomic batch and one unique claim.
 // A racing callback cannot reuse an already consumed invitation.
 const result=await p.env.DB.batch([
  p.store.query('UPDATE pa_invites SET accepted_at=?,accepted_user_id=?,claim_id=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?',now,user,claim,invite.id,now),
  p.store.query('INSERT INTO pa_beta_members(user_id,invite_id,created_at) SELECT ?,id,? FROM pa_invites WHERE id=? AND claim_id=? ON CONFLICT(user_id) DO UPDATE SET invite_id=excluded.invite_id,created_at=excluded.created_at,revoked_at=NULL',user,now,invite.id,claim),
  p.store.query('INSERT INTO pa_users(id,login,created_at) SELECT ?,?,? FROM pa_invites WHERE id=? AND claim_id=? ON CONFLICT(id) DO UPDATE SET login=excluded.login,disabled_at=NULL',user,identity.name,now,invite.id,claim),
 ]);
 if(!result[0].meta.changes)throw new Fault(409,'invitation_unavailable');return user;
}
export async function revokeInvite(p,user,id){
 requireAdmin(p,user);const invite=await p.store.one('SELECT * FROM pa_invites WHERE id=?',id);if(!invite)throw new Fault(404,'not_found');
 const account=invite.accepted_user_id?await p.store.one('SELECT * FROM pa_users WHERE id=?',invite.accepted_user_id):null;
 const disable=account&&!isAdmin(p.env,account.id)&&!loginAllowed(p.env,account.login),now=p.now();
 const changes=[p.store.query('UPDATE pa_invites SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',now,id),p.store.query('UPDATE pa_beta_members SET revoked_at=COALESCE(revoked_at,?) WHERE invite_id=?',now,id)];
 if(disable)changes.push(p.store.query('UPDATE pa_users SET disabled_at=? WHERE id=? AND EXISTS(SELECT 1 FROM pa_beta_members WHERE user_id=? AND invite_id=?)',now,account.id,account.id,id));
 const result=await p.env.DB.batch(changes);return {revoked:true,accessDisabled:!!result[2]?.meta.changes};
}
