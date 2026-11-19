const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link=url=>/^https:\/\//.test(url??'')?esc(url):'#';
const labels={disconnected:'未连接',available:'可连接',connected:'已连接',needs_auth:'需重新授权',error:'同步异常',needs_project:'待匹配项目',needs_info:'待补充验收',queued:'待执行',awaiting_approval:'待确认',dispatching:'派发中',running:'开发中',backfilling:'正在回填',review_ready:'待审阅 PR',failed:'执行失败'};
const messages={legacy_relay_active:'此 Repo 的旧版 Focus Board 接力仍在运行。请完成迁移验收并停用旧工作流后，再安装新执行器。',project_has_active_run:'项目有正在执行或回填的任务，请等待完成后再修改绑定。',oauth_configuration_required:'请先配置 OAuth 应用。',sign_in_required:'请先登录后打开工作台。',project_sync_failed:'GitHub 登录已成功，但项目同步失败。请在 Connector 中重试同步。',preauth_required:'登录会话已过期，请重新点击“使用 GitHub 登录”。',github_login_not_allowed:'这个 GitHub 账号不在允许登录名单中，请联系部署者添加。',origin_mismatch:'请求来源不匹配，请刷新页面。',agent_not_connected:'请先连接 BigModel Agent。',github_connection_required:'请先授权 GitHub Connector。',runner_installation_required:'请在项目中安装云端执行器。',linear_team_required:'请选择这个 Linear 项目所属的团队。',different_account_disconnect_first:'这个 Connector 已绑定其他账号，请先断开原账号。',provider_http_403:'授权范围或组织策略阻止访问，请检查应用权限。',repository_already_managed:'这个 Repo 已由另一个项目管理，请先解除原绑定。',agent_key_missing:'请连接你自己的 Agent API Key。',agent_key_rejected:'密钥校验失败，请确认账号已开通 Managed Agent API。',feishu_offline_scope_required:'飞书授权缺少离线访问，请让应用管理员开通 offline_access 后重新授权。',repository_already_bound:'这个 Repo 已绑定另一个项目，请先调整绑定。'};
let state,view='connectors',search='',refreshing=false;
async function api(path,body){
 const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const result=await response.json();if(!response.ok){const error=new Error(messages[result.error]||result.error||'请求失败');if(result.loginUrl)error.loginUrl=result.loginUrl;throw error;}return result;
}
function notice(text){$('#notice').textContent=text;$('#notice').hidden=!text;}
const badge=status=>`<span class="status ${['connected','review_ready'].includes(status)?'good':['needs_auth','failed','error','needs_project','needs_info'].includes(status)?'warn':''}">${esc(labels[status]||status)}</span>`;
function showModal(title,content){$('#modal-title').textContent=title;$('#modal-body').innerHTML=content;$('#modal').showModal();}
function closeModal(){$('#modal').close();$('#modal-body').replaceChildren();}
$('#close-modal').addEventListener('click',closeModal);
$('#modal').addEventListener('close',()=>$('#modal-body').replaceChildren());
async function refresh(){
 if(refreshing)return;refreshing=true;
 try{state=await api('state');$('#project-count').textContent=state.projects.filter(p=>p.active).length;$('#task-count').textContent=state.tasks.length;$('#scheduler').textContent=state.scheduler?'每 5 分钟检查会议'+(state.schedulerLast?' · 上次 '+new Date(state.schedulerLast.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})+(state.schedulerLast.status==='completed'?' 检查完成':' 检查异常，将重试'):' · 等待首次检查'):'云端调度待配置';render();}
 catch(error){notice(error.message);$('#content').innerHTML=error.loginUrl
  ?'<div class="empty"><div class="connector-icon">⑂</div><h2>使用 GitHub 登录</h2><p>本工作台独立部署，请使用你的 GitHub 账号登录后继续。登录状态仅保存在本站 Cookie 中。</p><a class="button" href="'+esc(error.loginUrl)+'">使用 GitHub 登录</a></div>'
  :'<div class="empty"><h2>暂时无法读取工作区</h2><p>请确认登录状态，或稍后刷新重试。</p></div>';}
 finally{refreshing=false;}
}
function render(){
 view=['projects','tasks'].includes(location.hash.slice(1))?location.hash.slice(1):'connectors';
 const titles={connectors:['Connectors','连接会议、项目管理和执行 Agent。配置一次，让任务带着项目上下文进入开发。'],projects:['Projects','授权后自动同步项目。为需要执行的项目绑定 Repo、Agent 和验收规则。'],tasks:['Agent Tasks','从会议原话到开发成果。项目、原需求、云端运行与 Pull Request 始终关联。']};
 $('#page-title').textContent=titles[view][0];$('#page-subtitle').textContent=titles[view][1];document.querySelectorAll('[data-view]').forEach(a=>a.classList.toggle('active',a.dataset.view===view));
 renderOnboarding();
 if(view==='connectors')renderConnectors();else if(view==='projects')renderProjects();else renderTasks();
}
function renderConnectors(){
 const sections=[['meeting','会议来源','使用你授权的会议资料'],['project','项目管理','同步项目，回填开发结果'],['agent','执行 Agent','使用你自己的 Agent 账号']];
 $('#content').innerHTML=sections.map(([kind,title,note])=>`<div class="category"><div class="category-head"><h2>${title}</h2><span>${note}</span></div><div class="cards">${state.connectors.filter(c=>c.kind===kind).map(c=>{
  const oauth=c.auth==='oauth';
  const controls=oauth?`${c.configured?`<a class="button ${c.status==='connected'?'secondary':''}" href="/api/oauth/${c.id}/start">${c.status==='connected'?'重新授权':'授权连接'}</a>`:'<span class="modal-note">部署者尚未配置共享应用，可使用自有应用。</span>'}${c.connectionId&&c.status!=='disconnected'?`<button class="button secondary" data-sync="${c.connectionId}">${kind==='meeting'?'检查会议':'同步项目'}</button>`:''}`:`<button class="button ${c.status==='connected'?'secondary':''}" data-agent="${c.id}">${c.status==='connected'?'更换密钥':'连接自己的 Agent'}</button>`;
  return `<article class="connector-card"><div class="card-title"><span class="connector-icon">${esc(c.icon)}</span><h3>${esc(c.name)}</h3>${badge(c.status)}</div><p>${esc(c.description)}</p><div class="capabilities">${c.capabilities.map(x=>`<span>${esc(x)}</span>`).join('')}</div>${c.error?`<p class="error-line connector-error">${esc(messages[c.error]||c.error)}</p>`:''}<div class="card-footer"><div class="connection-meta">${esc(c.identity?.name||'等待连接')}<br>${c.lastSync?'同步于 '+new Date(c.lastSync).toLocaleString('zh-CN'):'尚未同步'}</div><div class="card-actions">${controls}${c.connectionId&&c.status!=='disconnected'?`<button class="quiet danger" data-disconnect="${c.connectionId}">断开</button>`:''}</div></div>${oauth?`<details class="advanced"><summary>使用自有 OAuth 应用</summary><p>自托管或共享应用不适用于你的组织时，在这里配置自己的应用。</p><button class="quiet" data-config="${c.id}">配置应用</button></details>`:''}</article>`;
 }).join('')}</div></div>`).join('');
}
function renderOnboarding(){
 const connected=id=>state.connectors.some(c=>c.id===id&&c.status==='connected');
 const steps=[['GitHub 登录',connected('github')],['授权飞书',connected('feishu')],['连接 Agent',connected('bigmodel')],['绑定 Repo',state.projects.some(p=>p.active&&p.binding?.runnerReady)]];
 $('#onboarding').innerHTML=steps.every(s=>s[1])?'':`<section class="onboarding"><h2>接上你的第一条工作流</h2><p>授权你自己的账号，绑定项目。最新可读妙记会进入检查，之后每五分钟发现新会议。</p><ol>${steps.map(([label,done],i)=>`<li class="${done?'done':''}"><span>${done?'✓':i+1}</span>${esc(label)}</li>`).join('')}</ol><a class="quiet" href="${connected('feishu')&&connected('bigmodel')?'#projects':'#connectors'}">${connected('feishu')&&connected('bigmodel')?'选择项目并绑定仓库':'配置 Connectors'} →</a></section>`;
 $('#account-label').textContent=state.account?.login||'';$('#logout').hidden=!state.account;$('#check-now').hidden=!connected('feishu')||!connected('bigmodel');
}
function configureAgent(){
 showModal('连接 BigModel Managed Agent',`<p class="modal-note">填写你自己的 BigModel API Key。它仅用于你的会议提取和云端开发，加密保存，不会回显。安装执行器时，只会写入你选定 Repo 的加密 Actions Secret。</p><form id="agent-form"><label for="agent-key">BigModel API Key</label><input id="agent-key" type="password" name="apiKey" autocomplete="new-password" required minlength="10" maxlength="4096"><p class="scope-note">需要同时具备模型调用和 Managed Agent API 访问权限。用量计入你的账号。</p><div class="form-footer"><button type="submit" class="button">验证并保存</button></div></form>`);
 $('#agent-form').addEventListener('submit',async e=>{e.preventDefault();await perform(e.submitter,async()=>{const result=await api('agents/bigmodel/settings',Object.fromEntries(new FormData(e.target)));e.target.reset();closeModal();await refresh();notice(result.reinstall?.length?'密钥已保存，部分仓库需重新安装执行器。':'Agent 已连接，准备好后会自动检查会议。');});});
}
function renderProjects(){
 const active=state.projects.filter(p=>p.active);const visible=active.filter(p=>(p.name+' '+p.description).toLowerCase().includes(search.toLowerCase()));
 if(!active.length){$('#content').innerHTML='<div class="empty"><div class="connector-icon">▣</div><h2>把已有的项目带进来</h2><p>连接 GitHub Projects 或 Linear 后，项目会自动出现在这里。选择一个项目，绑定 Repo 和 Agent。</p><a class="button" href="#connectors">连接项目平台</a></div>';return;}
 $('#content').innerHTML=`<div class="section-tools"><input id="project-search" type="search" placeholder="搜索项目" aria-label="搜索项目" value="${esc(search)}"><span>${active.length} 个可读项目 · 已同步至云端</span></div><div class="project-list">${visible.map(p=>{const source=state.connectors.find(c=>c.connectionId===p.connection_id),b=p.binding;return `<article class="project-card"><div class="project-heading"><div><p class="project-source">${esc(source?.name)} · ${esc(p.metadata.teams?.map(t=>t.name).join(' / ')||'项目')}</p><h3><a href="${link(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a></h3></div><span class="status ${b?.runnerReady?'good':''}">${b?.runnerReady?'执行器已安装':b?'已绑定 · 待安装':'待绑定 Repo 与 Agent'}</span></div><p class="project-description">${esc(p.description||'来源平台暂无项目说明')}</p>${b?`<div class="project-binding"><span>⑂ ${esc(b.repo)}</span><span>BigModel Managed</span><span>${b.automatic?'自动执行已开启':'执行前确认'}</span><span>${esc(b.validation.join(' · '))}</span></div>`:''}<div class="project-bottom"><small>同步于 ${new Date(p.synced_at).toLocaleString('zh-CN')}</small><div class="card-actions"><button class="button secondary" data-bind="${p.id}">${b?'编辑绑定':'绑定 Repo 与 Agent'}</button>${b?`<button class="button ${b.runnerReady?'secondary':''}" data-install="${p.id}">${b.runnerReady?'更新云端执行器':'安装云端执行器'}</button><button class="quiet danger" data-unbind="${p.id}">解除绑定</button>`:''}</div></div></article>`;}).join('')||'<div class="empty"><p>没有匹配的项目。</p></div>'}</div>`;
 $('#project-search').addEventListener('input',event=>{const position=event.target.selectionStart;search=event.target.value;renderProjects();$('#project-search').focus();$('#project-search').setSelectionRange(position,position);});
}
function renderTasks(){
 if(!state.tasks.length){$('#content').innerHTML='<div class="empty"><div class="connector-icon">☷</div><h2>下一场会议，就是任务的起点</h2><p>连接会议来源，并完成项目绑定后，明确的开发待办会自动进入这里。需求不完整或项目不明确时，会等待你的确认。</p><a href="#connectors" class="button secondary">查看 Connectors</a></div>';return;}
 $('#content').innerHTML=`<div class="task-list">${state.tasks.map(row=>{const t=row.payload,p=state.projects.find(p=>p.id===row.project_id);return `<article class="task-card"><div class="project-heading"><h3>${esc(t.title)}</h3>${badge(row.status)}</div><div class="task-meta">${esc(p?.name||'项目待确认')} · ${esc(t.meetingTitle)} · ${esc(row.id.slice(0,18))}</div><p>${esc(t.goal)}</p><details><summary>验收条件与会议依据</summary><ul>${t.acceptance.map(a=>`<li>${esc(a)}</li>`).join('')}</ul><blockquote>${esc(t.evidence)}</blockquote></details>${t.error?`<p class="error-line">${esc(messages[t.error]||t.error)}</p>`:''}<div class="task-links">${t.meetingUrl?`<a target="_blank" rel="noopener noreferrer" href="${link(t.meetingUrl)}">来源会议</a>`:''}${t.original?`<a target="_blank" rel="noopener noreferrer" href="${link(t.original.url)}">原需求</a>`:''}${t.result?`<a target="_blank" rel="noopener noreferrer" href="${link(t.result.pr)}">查看 Pull Request</a><a target="_blank" rel="noopener noreferrer" href="${link(t.result.runUrl)}">测试与运行</a><button class="quiet" data-verify="${row.id}">核验交付</button>`:''}${['needs_project','needs_info','awaiting_approval','failed'].includes(row.status)?`<button class="quiet" data-approve="${row.id}">${row.status==='failed'?'检查并重试':'确认任务'}</button>`:''}</div></article>`;}).join('')}</div>`;
}
function configure(id){
 const c=state.connectors.find(c=>c.id===id);
 showModal('配置 '+c.name,`<p class="modal-note">先在平台创建 OAuth 应用，将下方地址填写为回调地址。Client Secret 加密保存在云端，保存后不会显示。</p><p><a href="${link(c.setup)}" target="_blank" rel="noopener noreferrer">打开官方应用配置说明</a></p><form id="config-form"><label for="callback">Authorization callback URL</label><input id="callback" readonly value="${esc(c.callback)}"><small>点击地址框可全选复制。</small><label for="client-id">Client ID</label><input id="client-id" name="clientId" required autocomplete="off" value="${esc(c.clientId)}"><label for="client-secret">Client Secret</label><input id="client-secret" name="clientSecret" type="password" autocomplete="new-password" ${c.configured?'':'required'} placeholder="${c.configured?'留空保留已保存的 Secret':'填写 OAuth 应用的 Client Secret'}"><div class="scope-note">${id==='feishu'?'授权用途：读取你自己的身份、可读妙记和文字记录，并通过 offline_access 离线刷新授权。应用管理员须启用 auth:user.id:read / minutes:minutes.search:read / minutes:minutes.transcript:export / offline_access。':id==='github'?'授权用途：读取 Projects 和 Repo、创建 Issue 与 PR、安装选定 Repo 的云端工作流。OAuth App 会请求 repo / project / workflow / read:org / offline_access 权限。':'授权用途：读取项目和需求、创建需求、回填评论。请求 read / issues:create / comments:create 权限。'}</div><div class="form-footer"><button class="button" type="submit">保存应用配置</button></div></form>`);
 $('#callback').addEventListener('click',e=>e.target.select());
 $('#config-form').addEventListener('submit',async e=>{e.preventDefault();await perform(e.submitter,async()=>{await api('connectors/'+id+'/settings',Object.fromEntries(new FormData(e.target)));closeModal();await refresh();notice('应用配置已保存，现在可以点击“授权连接”。');});});
}
async function bind(id){
 const p=state.projects.find(p=>p.id===id),b=p.binding||{};
 const github=state.connectors.find(c=>c.id==='github'&&c.status==='connected');
 const agent=state.connectors.find(c=>c.id==='bigmodel'&&c.status==='connected');
 if(!github||!agent){notice('请先在 Connectors 中连接 GitHub 和 BigModel Agent。');return;}
 showModal('绑定 '+p.name,'<p class="modal-note">正在读取你有写入权限的 Repo…</p>');
 try{
 const repos=await api('repositories?connection='+encodeURIComponent(github.connectionId));if(!repos.length)throw Error('没有可写的 Repo，请检查 GitHub 授权范围。');
 const teams=p.metadata.teams||[];
 $('#modal-body').innerHTML=`<p class="modal-note">来源项目提供需求与上下文；这里确定代码要在哪里、由谁开发，以及如何验收。</p><form id="bind-form"><label for="repo">GitHub Repo</label><select name="repo" id="repo">${repos.map(r=>`<option value="${esc(r.name)}" ${r.name===b.repo?'selected':''}>${esc(r.name)}</option>`).join('')}</select><label for="agent">执行 Agent</label><select name="agent" id="agent"><option value="bigmodel">BigModel Managed Agent · 云端</option></select>${teams.length>1?`<label for="team">需求所属团队</label><select name="teamId" id="team">${teams.map(t=>`<option value="${esc(t.id)}" ${b.teamId===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select>`:''}<label for="validation">验收命令（每行一条）</label><textarea id="validation" name="validation" required placeholder="npm ci&#10;npm test">${esc((b.validation||['npm test']).join('\n'))}</textarea><small>在独立的 GitHub runner 运行。测试通过后才会创建草稿 PR。</small><label for="paths">允许修改的文件或目录（每行一项）</label><textarea id="paths" name="allowedPaths" required placeholder="src/&#10;test/">${esc((b.allowedPaths||['src/','test/','tests/']).join('\n'))}</textarea><small>目录以 / 结尾。工作流和环境配置不允许由编码 Agent 修改。</small><label for="aliases">会议中常用的项目别名（每行一个）</label><textarea name="aliases" id="aliases" placeholder="产品简称或团队常用名">${esc((b.aliases||[]).join('\n'))}</textarea><label class="check-label"><input name="automatic" type="checkbox" ${b.automatic!==false?'checked':''}>符合项目和验收条件的会议待办自动执行</label><div class="form-footer"><button class="button" type="submit">保存并安装执行器</button></div></form>`;
 $('#bind-form').addEventListener('submit',async e=>{e.preventDefault();await perform(e.submitter,async()=>{const data=Object.fromEntries(new FormData(e.target));const lines=v=>v.split('\n').map(s=>s.trim()).filter(Boolean);const binding=await api('projects/'+id+'/bind',{...data,githubConnectionId:github.connectionId,validation:lines(data.validation),allowedPaths:lines(data.allowedPaths),aliases:lines(data.aliases),automatic:data.automatic==='on'});if(!binding.runnerReady)await api('projects/'+id+'/install',{});closeModal();await refresh();notice('项目绑定和云端执行器已准备好，会议检查已排队。');});});
 }catch(error){closeModal();notice(error.message);}
}
function install(id){
 const p=state.projects.find(p=>p.id===id);
 showModal('安装云端执行器',`<p class="modal-note">将在 <strong>${esc(p.binding.repo)}</strong> 的默认分支安装 Progressive Agent 工作流和 runner，并配置加密的执行凭据。之后编码、测试和 PR 创建都在云端完成。</p><p class="info-box">只有项目绑定中允许的文件可由 Agent 修改。测试阶段不持有发布凭据，测试通过后才创建草稿 PR。</p><form id="install-form"><div class="form-footer"><button type="submit" class="button">安装到此 Repo</button></div></form>`);
 $('#install-form').addEventListener('submit',async e=>{e.preventDefault();await perform(e.submitter,async()=>{await api('projects/'+id+'/install',{});closeModal();await refresh();notice('云端执行器已安装。后续符合条件的会议待办会自动进入开发队列。');});});
}
function unbind(id){
 const p=state.projects.find(p=>p.id===id);
 showModal('解除项目绑定',`<p class="modal-note">解除 <strong>${esc(p.name)}</strong> 与 ${esc(p.binding.repo)} 的绑定。后续任务将等待重新选择项目；已有 PR 会保留。正在运行的项目须等待本轮完成。</p><form id="unbind-form"><div class="form-footer"><button class="button" type="submit">解除绑定</button></div></form>`);
 $('#unbind-form').addEventListener('submit',async e=>{e.preventDefault();await perform(e.submitter,async()=>{await api('projects/'+id+'/unbind',{});closeModal();await refresh();notice('绑定已解除，可以将 Repo 绑定至另一个项目。');});});
}
async function verifyDelivery(id){
 showModal('核验云端交付','<p class="modal-note">正在读取仓库中的实际运行和回填记录…</p>');
 try{const result=await api('tasks/'+id+'/verification');$('#modal-body').innerHTML=`<p>云端运行：<strong>${esc(result.run.conclusion||result.run.status)}</strong> · 第 ${esc(result.run.attempt)} 次</p><ul>${result.jobs.map(j=>'<li>'+esc(j.name)+' · '+esc(j.conclusion||j.status)+'</li>').join('')}</ul><p>Pull Request：${result.pull.draft?'草稿 · ':''}${esc(result.pull.state)} · 本任务 ${result.pullCount} 个 PR${result.pullsComplete?'':'（分页未完整）'}</p><p>原需求回填：${result.backfill?result.backfill.comments.length+' 条结果评论'+(result.backfill.complete?'':'（分页未完整）'):'请打开原需求核对'}</p>${result.backfill?.comments.map(c=>'<pre class="modal-note">'+esc(c.body)+'</pre>').join('')||''}`;}catch(error){$('#modal-body').innerHTML='<p class="error-line">'+esc(error.message)+'</p>';}
}
function approve(id){
 const row=state.tasks.find(t=>t.id===id);const projects=state.projects.filter(p=>p.active&&p.binding);
 if(!projects.length){notice('请先完成至少一个项目的 Repo 与 Agent 绑定。');return;}
 showModal('确认开发任务',`<p class="modal-note">${esc(row.payload.title)}</p><form id="approve-form"><label for="task-project">所属项目</label><select name="projectId" id="task-project">${projects.map(p=>`<option value="${p.id}" ${p.id===row.project_id?'selected':''}>${esc(p.name)} · ${esc(p.binding.repo)}</option>`).join('')}</select><label for="acceptance">验收条件（每行一项）</label><textarea name="acceptance" id="acceptance" required>${esc(row.payload.acceptance.join('\n'))}</textarea><div class="form-footer"><button type="submit" class="button">确认并加入队列</button></div></form>`);
 $('#approve-form').addEventListener('submit',async e=>{e.preventDefault();await perform(e.submitter,async()=>{const data=Object.fromEntries(new FormData(e.target));await api('tasks/'+id+'/approve',{projectId:data.projectId,acceptance:data.acceptance.split('\n').map(s=>s.trim()).filter(Boolean)});closeModal();await refresh();notice('任务已进入队列，等待下一轮云端调度。');});});
}
async function perform(button,action){const old=button?.textContent;try{if(button){button.disabled=true;button.textContent='处理中…';}await action();}catch(e){notice(e.message);const existing=$('#modal .form-error');if($('#modal').open){existing?.remove();const p=document.createElement('p');p.className='error-line form-error';p.textContent=e.message;$('#modal-body').append(p);}}finally{if(button?.isConnected){button.disabled=false;button.textContent=old;}}}
$('#content').addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.config)return configure(b.dataset.config);
 if(b.dataset.agent)return configureAgent();
 if(b.dataset.bind)return bind(b.dataset.bind);
 if(b.dataset.install)return install(b.dataset.install);
 if(b.dataset.approve)return approve(b.dataset.approve);
 if(b.dataset.verify)return verifyDelivery(b.dataset.verify);
 if(b.dataset.unbind)return unbind(b.dataset.unbind);
 await perform(b,async()=>{
 if(b.dataset.sync){const result=await api('connectors/'+b.dataset.sync+'/sync',{});notice(state.connectors.find(c=>c.connectionId===b.dataset.sync)?.kind==='meeting'?'会议检查已提交至云端。':'项目同步完成。');}
 if(b.dataset.activate){await api('connectors/'+b.dataset.activate+'/activate',{});notice('Connector 已连接。');}
 if(b.dataset.disconnect){await api('connectors/'+b.dataset.disconnect+'/disconnect',{});notice('连接已断开，后续新任务停止派发。');}
 await refresh();});
});
$('#refresh').addEventListener('click',e=>perform(e.target,refresh));
$('#check-now').addEventListener('click',e=>perform(e.target,async()=>{const r=await api('check',{});notice(r.queued?'云端检查已排队。':'本轮已排队或已检查，稍后会自动更新。');}));
$('#logout').addEventListener('click',e=>perform(e.target,async()=>{await api('logout',{});state=null;$('#onboarding').replaceChildren();$('#account-label').textContent='';$('#logout').hidden=true;$('#check-now').hidden=true;location.href='/app';}));
window.addEventListener('hashchange',()=>{if(state)render();});
const params=new URLSearchParams(location.search);if(params.get('connected'))notice('授权成功，连接状态已更新。');if(params.get('error'))notice(messages[params.get('error')]||params.get('error'));
refresh();
// Keep cloud progress current without interrupting a form or background tab.
setInterval(()=>{if(!document.hidden&&!$('#modal').open&&!document.activeElement?.matches('input,textarea,select'))refresh();},15000);
