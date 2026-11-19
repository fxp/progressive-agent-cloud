import {ConnectorRegistry} from './registry.mjs';
import {agentManifests,agentPlugin} from './agents.mjs';
import {githubRepository} from './github-repository.mjs';
import {scanSource} from '../sources.mjs';
import {drainMeetings} from '../meeting-webhook.mjs';

const meetingManifests=[
 {id:'meeting-webhook',kind:'meeting',name:'会议纪要 Webhook',icon:'↳',description:'接收会议待办与纪要原文，持久化、澄清和去重',auth:'webhook',capabilities:['discover','read','meeting_todos','cited_notes','deduplicate','status']},
 {id:'feishu',kind:'meeting',name:'飞书妙记',icon:'F',description:'授权自己的账号，自动发现新妙记及待办',auth:'oauth',capabilities:['discover','read','evidence']},
];
const projectManifests=[
 {id:'github',kind:'project',name:'GitHub',icon:'⑂',description:'项目、代码仓库与 Issue 回填使用同一授权连接',auth:'oauth',roles:['project','repository','delivery'],capabilities:['projects','issues','repositories','pull_requests','backfill']},
 {id:'linear',kind:'project',name:'Linear',icon:'L',description:'同步项目、创建来源需求并回填成果',auth:'oauth',roles:['project','delivery'],capabilities:['projects','issues','backfill']},
 {id:'gitlab',kind:'project',name:'GitLab Issues',icon:'G',description:'同步 GitLab.com 项目和需求，回填已绑定仓库的 PR',auth:'access_token',roles:['project','delivery'],capabilities:['projects','issues','backfill']},
];

// This is the only composition root: extending the product requires a new
// plugin module and register(), not provider branches in orchestration.
export function createRegistry(extensions=[]){
 const registry=new ConnectorRegistry();
 for(const manifest of meetingManifests){
  const id=manifest.id;
  registry.register({manifest:{...manifest,apiVersion:1,roles:['meeting']},meeting:id==='feishu'?{
   discover:({platform:p,scan,legacy},connection)=>scan?scan(p,connection):connection.credential?scanSource(p,connection):legacy(),
   read:async({platform:p},connection,item)=>{const token=await p.access(connection);return connection.identity.meetingContent==='todos'?p.providers.todoEvidence(token,item.externalId):{transcript:await p.providers.transcript(token,item.externalId)};},
  }:{discover:({platform:p},connection)=>drainMeetings(p,connection.user_id),read:async(_,__,event)=>event.meeting}});
 }
 for(const manifest of projectManifests){const id=manifest.id;registry.register({manifest:{...manifest,apiVersion:1},project:{
  list:({platform:p},token)=>p.providers.projects(id,token),
  createRequirement:({platform:p},token,project,task)=>p.providers.issue(id,token,project,task),
 },delivery:{backfill:({platform:p},token,project,task)=>p.providers.backfill(id,token,project,task)},...(id==='github'?{repository:githubRepository}:{})});}
 for(const manifest of agentManifests)registry.register(agentPlugin(manifest));
 for(const plugin of extensions)registry.register(plugin);
 return registry;
}
export const registry=createRegistry();
