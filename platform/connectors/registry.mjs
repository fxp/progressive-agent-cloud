import {Fault} from '../security.mjs';

export const contracts=Object.freeze({
 meeting:['discover','read'],
 project:['list','createRequirement'],
 agent:['validate','credential','execution','completeJSON'],
 repository:['repository','repositories','install','dispatch','runs','run','rerun','verify','baseline','publish','verification','refreshCredentials'],
 delivery:['backfill'],
});

export class ConnectorRegistry{
 #plugins=new Map();
 register(plugin){
  const m=plugin?.manifest;
  if(!m||!/^[-a-z0-9]+$/.test(m.id??'')||m.apiVersion!==1||typeof m.name!=='string'||!m.name.trim()||!Array.isArray(m.roles)||!m.roles.length||new Set(m.roles).size!==m.roles.length||!Array.isArray(m.capabilities))throw new Fault(400,'invalid_connector_manifest');
  if(this.#plugins.has(m.id))throw new Fault(409,'connector_already_registered');
  for(const role of m.roles){if(!contracts[role]||!plugin[role]||contracts[role].some(method=>typeof plugin[role][method]!=='function'))throw new Fault(400,'connector_contract_missing');}
  const manifest=Object.freeze({...m,roles:Object.freeze([...m.roles]),capabilities:Object.freeze([...m.capabilities])});
  this.#plugins.set(m.id,Object.freeze({...plugin,manifest}));return this;
 }
 get(id,role){const plugin=this.#plugins.get(id);if(!plugin||role&&!plugin.manifest.roles.includes(role))throw new Fault(400,'unsupported_connector_'+(role??'id'));return role?plugin[role]:plugin;}
 list(role){return [...this.#plugins.values()].filter(p=>!role||p.manifest.roles.includes(role)).map(p=>p.manifest);}
 has(id,role){return this.#plugins.has(id)&&(!role||this.#plugins.get(id).manifest.roles.includes(role));}
}
