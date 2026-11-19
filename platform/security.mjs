const encode = new TextEncoder();
export class Fault extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export const requireValue = (value, code) => { if (!value) throw new Fault(400, code); return value; };
export const b64 = bytes => btoa(String.fromCharCode(...bytes));
export const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export const random = () => b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(text)))].map(c => c.toString(16).padStart(2, '0')).join('');
export const challenge = async text => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(text)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
async function key(secret) {
  if (!secret || unb64(secret).length !== 32) throw new Fault(503, 'encryption_not_configured');
  return crypto.subtle.importKey('raw', unb64(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:encode.encode(context)}, await key(secret), encode.encode(JSON.stringify(value)));
  return JSON.stringify({v:1, iv:b64(iv), data:b64(new Uint8Array(data))});
}
export async function open(secret, value, context) {
  const envelope = JSON.parse(value);
  const data = await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(envelope.iv), additionalData:encode.encode(context)}, await key(secret), unb64(envelope.data));
  return JSON.parse(new TextDecoder().decode(data));
}
export function validateBinding(input) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo ?? '')) throw new Fault(400, 'invalid_repository');
  if (input.agent !== 'bigmodel') throw new Fault(400, 'unsupported_agent');
  if (!Array.isArray(input.validation) || !input.validation.length || input.validation.length > 5 || input.validation.some(c => typeof c !== 'string' || !c.trim() || c.length > 300 || /[\r\n]/.test(c))) throw new Fault(400, 'validation_required');
  if (!Array.isArray(input.allowedPaths) || !input.allowedPaths.length || input.allowedPaths.some(p => typeof p !== 'string' || !/^[\w./-]+$/.test(p) || p.startsWith('/') || p.split('/').includes('..') || p.startsWith('.git') || p.startsWith('.env'))) throw new Fault(400, 'invalid_allowed_paths');
  return {repo:input.repo, githubConnectionId:String(input.githubConnectionId ?? ''), agent:'bigmodel', validation:input.validation.map(c=>c.trim()), allowedPaths:input.allowedPaths, aliases:(Array.isArray(input.aliases)?input.aliases:[]).filter(a=>typeof a==='string' && a.trim().length>2).slice(0,20), automatic:input.automatic === true, teamId:input.teamId || null, sourceEnabled:true};
}
export function matchProject(action, projects) {
  const explicit = projects.filter(p => action.projectId && action.projectId === p.id);
  if (explicit.length === 1) return explicit[0];
  const normalize = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const mentions=(text,name)=>{
    if(normalize(name).length<3)return false;
    const parts=String(name).normalize('NFKC').toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);
    const pattern=parts.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[\\s\\p{P}]*');
    return new RegExp((/^[a-z0-9]/.test(parts[0])?'(?<![a-z0-9])':'')+pattern+(/[a-z0-9]$/.test(parts.at(-1))?'(?![a-z0-9])':''),'u').test(String(text).normalize('NFKC').toLowerCase());
  };
  const hits = text => projects.filter(p => [p.name, ...(p.binding?.aliases ?? [])].some(name => mentions(text,name)));
  // A model's guessed project and a multi-project meeting title must never
  // override the TODO that actually initiated the work.
  const own = hits([action.evidence, action.title, action.goal].filter(Boolean).join('\n'));
  if(own.length)return own.length===1?own[0]:null;
  if(action.project&&hits(action.project).length!==1)return null;
  const context=hits(action.context??'');
  return context.length===1?context[0]:null;
}
