import {Fault} from './security.mjs';

// Standalone GitHub login mode (PA_AUTH_MODE=github).
// Signed browser cookies: HMAC-SHA256 over a base64url payload with an
// embedded context and expiry. Every verification failure — tampering,
// wrong context, expiry, malformed input, unconfigured key — yields null
// and never throws, so a bad cookie can never produce a 500.
export const SESSION_COOKIE='pa_session';
export const PREAUTH_COOKIE='pa_preauth';
export const SESSION_CONTEXT='pa:session:v1';
export const PREAUTH_CONTEXT='pa:preauth:v1';
export const SESSION_TTL_MS=7*24*60*60*1000;      // 7 days
export const PREAUTH_TTL_MS=10*60*1000;           // 10 minutes

const encode=new TextEncoder();
const decode=new TextDecoder();
const b64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const unb64url=text=>{const padded=text.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(text.length/4)*4,'=');return Uint8Array.from(atob(padded),c=>c.charCodeAt(0));};

export function timingSafeEqual(a,b){
  if(!(a instanceof Uint8Array)||!(b instanceof Uint8Array)||a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}

async function hmacKey(secret){
  if(typeof secret!=='string'||!secret.trim())throw new Fault(503,'session_key_not_configured');
  let bytes;try{bytes=unb64url(secret.trim());}catch{throw new Fault(503,'session_key_not_configured');}
  if(bytes.length!==32)throw new Fault(503,'session_key_not_configured');
  return crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
}

// sign/verify pair a value with a context label; a token minted for one
// context (session) is rejected in the other (preauth) and vice versa.
export async function sign(value,{secret,context,ttlMs,now=Date.now()}){
  const payload=b64url(encode.encode(JSON.stringify({v:value,ctx:context,exp:now+ttlMs})));
  const signature=b64url(new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(secret),encode.encode(payload))));
  return payload+'.'+signature;
}

export async function verify(token,{secret,context,now=Date.now()}){
  try{
    if(typeof token!=='string'||!token)return null;
    const parts=token.split('.');
    if(parts.length!==2||!parts[0]||!parts[1])return null;
    const key=await hmacKey(secret);
    const expected=new Uint8Array(await crypto.subtle.sign('HMAC',key,encode.encode(parts[0])));
    if(!timingSafeEqual(expected,unb64url(parts[1])))return null;
    const data=JSON.parse(decode.decode(unb64url(parts[0])));
    if(data?.ctx!==context||typeof data.exp!=='number'||data.exp<=now)return null;
    return data.v??null;
  }catch{return null;}
}

export function readCookie(request,name){
  const header=request.headers.get('cookie');
  if(!header)return null;
  for(const part of header.split(';')){
    const index=part.indexOf('=');
    if(index>=0&&part.slice(0,index).trim()===name)return part.slice(index+1).trim();
  }
  return null;
}

// Secure attribute applies when the deployment is HTTPS (workers.dev host).
export function isSecureRequest(request,env){
  try{if(new URL(request.url).protocol==='https:')return true;}catch{}
  return String(env?.PA_ORIGIN??'').trim().toLowerCase().startsWith('https:');
}

export function setCookie(name,token,{maxAge,secure=true}){
  const parts=[`${name}=${token}`,'Path=/','SameSite=Lax','HttpOnly'];
  if(Number.isFinite(maxAge))parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if(secure)parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name,{secure=true}={}){
  return `${name}=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0${secure?'; Secure':''}`;
}

export async function sessionFrom(request,env,now=Date.now()){
  const token=readCookie(request,SESSION_COOKIE);
  if(!token)return null;
  const session=await verify(token,{secret:env.PA_SESSION_KEY,context:SESSION_CONTEXT,now});
  return session&&typeof session==='object'&&typeof session.user==='string'&&session.user?session:null;
}

export async function preauthFrom(request,env,now=Date.now()){
  const token=readCookie(request,PREAUTH_COOKIE);
  if(!token)return null;
  const pending=await verify(token,{secret:env.PA_SESSION_KEY,context:PREAUTH_CONTEXT,now});
  return pending&&typeof pending==='object'&&typeof pending.user==='string'&&pending.user?pending:null;
}

export async function sessionCookie(session,{secret,secure=true,now=Date.now()}){
  return setCookie(SESSION_COOKIE,await sign(session,{secret,context:SESSION_CONTEXT,ttlMs:SESSION_TTL_MS,now}),{maxAge:Math.floor(SESSION_TTL_MS/1000),secure});
}

export async function preauthCookie(pending,{secret,secure=true,now=Date.now()}){
  const value=typeof pending==='string'?{user:pending}:{user:pending.user,...(pending.inviteHash?{inviteHash:pending.inviteHash}:{})};
  return setCookie(PREAUTH_COOKIE,await sign(value,{secret,context:PREAUTH_CONTEXT,ttlMs:PREAUTH_TTL_MS,now}),{maxAge:Math.floor(PREAUTH_TTL_MS/1000),secure});
}

// PA_ALLOWED_GITHUB_LOGINS is a comma-separated GitHub login allowlist.
// Comparison is case-insensitive; a missing or empty list denies everyone.
export function loginAllowed(env,login){
  if(env?.PA_SIGNUP_MODE==='open')return /^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(String(login??''));
  const raw=String(env?.PA_ALLOWED_GITHUB_LOGINS??'').trim();
  if(!raw)return false;
  const needle=String(login??'').trim().toLowerCase();
  if(!needle)return false;
  return raw.split(',').map(entry=>entry.trim().toLowerCase()).filter(Boolean).includes(needle);
}

export function requireAllowedLogin(env,login){
  if(!loginAllowed(env,login))throw new Fault(403,'github_login_not_allowed');
}
