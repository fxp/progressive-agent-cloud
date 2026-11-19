import {Fault} from './security.mjs';

export class Providers {
  constructor(fetcher = fetch) { this.fetch = fetcher.bind(globalThis); }
  async request(url, token, body, method) {
    const response = await this.fetch(url, {method:method ?? (body ? 'POST' : 'GET'), headers:{authorization:`Bearer ${token}`, accept:'application/json', 'user-agent':'Progressive-Agent', ...(body ? {'content-type':'application/json'} : {})}, body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(25000)});
    if (!response.ok) throw new Fault(response.status === 401 || response.status === 403 ? 401 : 502, `provider_http_${response.status}`);
    if (response.status === 204) return {};
    const text=await response.text();
    if(!text.trim())return {};
    let result;try{result=JSON.parse(text);}catch{throw new Fault(502,'provider_response_invalid');}
    if (result.errors?.length) throw new Fault(502, 'provider_graphql_error');
    return result;
  }
  gh(token, path, body, method) { return this.request('https://api.github.com' + path, token, body, method); }
  async gql(provider, token, query, variables={}) {
    return (await this.request(provider === 'github' ? 'https://api.github.com/graphql' : 'https://api.linear.app/graphql', token, {query, variables})).data;
  }
  async paginate(read) {
    let cursor = null; const result = [];
    for (let page = 0; page < 100; page++) {
      const data = await read(cursor); result.push(...data.nodes);
      if (!data.pageInfo.hasNextPage) return result;
      if (!data.pageInfo.endCursor || data.pageInfo.endCursor === cursor) throw new Fault(502, 'invalid_pagination');
      cursor = data.pageInfo.endCursor;
    }
    throw new Fault(502, 'pagination_limit');
  }
  async identity(provider, token) {
    if (provider === 'github') {const u = await this.gh(token, '/user'); return {id:String(u.id), name:u.login};}
    if(provider==='feishu'){
      const r=await this.feishu(token,'/authen/v1/user_info');
      if(!r.open_id)throw new Fault(502,'feishu_identity_invalid');
      return {id:r.open_id,name:r.name??'飞书用户',tenantId:r.tenant_key??null};
    }
    const data = await this.gql('linear', token, '{ viewer { id name } organization { id name } }');
    return {id:data.organization.id, name:data.organization.name, viewerId:data.viewer.id};
  }
  async feishu(token,path,body,{raw=false}={}){
    const r=await this.fetch('https://open.feishu.cn/open-apis'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
    const text=await r.text();if(text.length>1500000)throw new Fault(413,'feishu_response_too_large');
    let value;try{value=JSON.parse(text);}catch{if(raw&&r.ok)return text.replace(/^\uFEFF/,'').trim();throw new Fault(502,'feishu_response_invalid');}
    if(!r.ok||value.code||value.error)throw new Fault(r.status===401||[99991663,99991668,99991671,99991677].includes(value.code)?401:502,'feishu_api_'+(value.code??r.status));
    if(raw)throw new Fault(409,'transcript_not_ready');return value.data??value;
  }
  async meetings(token,owner,{since,until,pageToken}){
    const query=new URLSearchParams({page_size:'30',...(pageToken?{page_token:pageToken}:{})});
    const data=await this.feishu(token,'/minutes/v1/minutes/search?'+query,{filter:{owner_ids:[owner],create_time:{start_time:new Date(since).toISOString(),end_time:new Date(until).toISOString()}},sorter:'create_time_desc'});
    const items=[];
    for(const item of data.items??[]){
      const meta=item.meta_data??{};let link;try{link=new URL(meta.app_link);}catch{}
      const fromLink=/^\/minutes\/([a-zA-Z0-9]{12,64})/.exec(link?.pathname??'')?.[1];
      const id=/^[a-zA-Z0-9]{12,64}$/.test(item.token??'')?item.token:fromLink;
      if(!id)continue;
      const host=link?.protocol==='https:'&&/^(?:[a-z0-9-]+\.)*feishu\.cn$/.test(link.hostname)?link.hostname:'feishu.cn';
      const title=String(item.display_info??item.title??item.topic??meta.title??'飞书会议').replace(/&(amp|lt|gt|quot|apos|#39);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",'#39':"'"}[entity])).replace(/<[^>]*>/g,' ').split(/\s*(?:关键词|所有者|开始时间|时长|Keywords?|Owner)\s*[:：]/i)[0].replace(/\s+/g,' ').trim().slice(0,200);
      items.push({externalId:id,title,url:'https://'+host+'/minutes/'+id});
    }
    return {items,nextPage:data.has_more?data.page_token:null};
  }
  async minuteInfo(token,id){
    if(!/^[A-Za-z0-9]{12,64}$/.test(id))throw new Fault(400,'invalid_meeting_id');
    const data=await this.feishu(token,'/minutes/v1/minutes/'+id),minute=data.minute??data;
    let url;try{const parsed=new URL(minute.url);if(parsed.protocol==='https:'&&/^(?:[a-z0-9-]+\.)*feishu\.cn$/.test(parsed.hostname)&&parsed.pathname==='/minutes/'+id)url=parsed.href;}catch{}
    return {externalId:id,title:String(minute.title??'飞书会议').slice(0,200),url:url??'https://feishu.cn/minutes/'+id};
  }
  transcript(token,id){
    if(!/^[a-zA-Z0-9]{12,64}$/.test(id))throw new Fault(400,'invalid_meeting_id');
    return this.feishu(token,'/minutes/v1/minutes/'+id+'/transcript?need_speaker=true&need_timestamp=true&file_format=txt',undefined,{raw:true});
  }
  async todoEvidence(token,id){
    if(!/^[a-zA-Z0-9]{12,64}$/.test(id))throw new Fault(400,'invalid_meeting_id');
    const data=await this.feishu(token,'/minutes/v1/minutes/'+id+'/artifacts');
    // This API also returns other AI artifacts. Retain only unfinished todos;
    // never persist or forward its transcript/summary fields in todo mode.
    if(!Array.isArray(data.minute_todos)||!data.minute_todos.length)throw new Fault(409,'meeting_todos_not_ready');
    const todos=data.minute_todos.filter(todo=>todo&&todo.is_done!==true&&typeof todo.content==='string'&&todo.content.trim()).map(todo=>({id:typeof todo.todo_id==='string'?todo.todo_id:null,content:todo.content.trim(),assignees:Array.isArray(todo.assignees)?todo.assignees.filter(a=>typeof a==='string'):[]}));
    return {transcript:todos.map(todo=>todo.content).join('\n\n'),sourceKind:'meeting_todos',sourceTodoIds:todos.map(todo=>todo.id).filter(Boolean),empty:todos.length===0};
  }
  async projects(provider, token) {
    if (provider === 'linear') {
      const nodes = await this.paginate(async cursor => (await this.gql('linear', token,
        'query($cursor:String){projects(first:100,after:$cursor){nodes{id name description url archivedAt teams{nodes{id name}}}pageInfo{hasNextPage endCursor}}}', {cursor})).projects);
      return nodes.filter(p=>!p.archivedAt).map(p=>({externalId:p.id,name:p.name,description:p.description,url:p.url,metadata:{teams:p.teams.nodes}}));
    }
    const organizations = await this.paginate(async cursor => (await this.gql('github', token, 'query($cursor:String){viewer{organizations(first:100,after:$cursor){nodes{login}pageInfo{hasNextPage endCursor}}}}', {cursor})).viewer.organizations);
    const fields = 'nodes{id title shortDescription url closed number}pageInfo{hasNextPage endCursor}';
    const own = await this.paginate(async cursor => (await this.gql('github', token, `query($cursor:String){viewer{login projectsV2(first:100,after:$cursor){${fields}}}}`, {cursor})).viewer.projectsV2);
    const all = [...own];
    for (const org of organizations) {
      all.push(...await this.paginate(async cursor => (await this.gql('github', token, `query($login:String!,$cursor:String){organization(login:$login){projectsV2(first:100,after:$cursor){${fields}}}}`, {login:org.login,cursor})).organization.projectsV2));
    }
    return all.filter(p=>!p.closed).map(p=>({externalId:p.id,name:p.title,description:p.shortDescription,url:p.url,metadata:{number:p.number}}));
  }
  async repositories(token) {
    const all=[];
    for (let page=1;page<=100;page++) {
      const rows = await this.gh(token, `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      all.push(...rows.filter(r=>!r.archived && !r.disabled && r.permissions?.push).map(r=>({name:r.full_name,defaultBranch:r.default_branch,url:r.html_url})));
      if (rows.length<100) return all;
    }
    throw new Fault(502,'pagination_limit');
  }
  async repository(token, repo) {
    const r=await this.gh(token, '/repos/'+repo);
    if (!r.permissions?.push || r.archived || r.disabled) throw new Fault(400,'repository_not_writable');
    return {name:r.full_name,defaultBranch:r.default_branch};
  }
  async issue(provider, token, project, task) {
    const marker = `<!-- progressive-agent:${task.id} -->`;
    const description = [task.goal,'', '验收条件',...task.acceptance.map(a=>'- '+a),'', '来源会议：'+task.meetingUrl,'', (task.sourceKind==='meeting_todos'?'纪要待办依据：':'原话依据：')+task.evidence,'',marker].join('\n');
    if (provider==='linear') {
      if (task.issueUrl) {
        const identifier=/^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z0-9-]+)(?:\/|$)/.exec(task.issueUrl)?.[1];
        if (!identifier) throw new Fault(400,'invalid_original_issue');
        const data=await this.gql('linear',token,'query($id:String!){issue(id:$id){id url project{id}}}',{id:identifier});
        if(data.issue.project?.id!==project.external_id) throw new Fault(400,'issue_project_mismatch');
        return {id:data.issue.id,url:data.issue.url};
      }
      const issues=await this.paginate(async cursor=>(await this.gql('linear',token,'query($id:String!,$cursor:String){project(id:$id){issues(first:100,after:$cursor){nodes{id url}pageInfo{hasNextPage endCursor}}}}',{id:project.external_id,cursor})).project.issues);
      const existing=issues.find(i=>i.id===task.externalCreateId);
      if(existing)return existing;
      const result=await this.gql('linear',token,'mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id url}}}',{input:{id:task.externalCreateId,title:task.title,description,projectId:project.external_id,teamId:project.binding.teamId}});
      if(!result.issueCreate.success || !result.issueCreate.issue)throw new Fault(502,'issue_create_failed');
      return result.issueCreate.issue;
    }
    const repo=project.binding.repo; let issue;
    if(task.issueUrl){
      const m=/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(task.issueUrl);
      if(!m || m[1].toLowerCase()!==repo.toLowerCase())throw new Fault(400,'invalid_original_issue');
      issue=await this.gh(token,`/repos/${repo}/issues/${m[2]}`);
      const result=await this.gql('github',token,'query($id:ID!){node(id:$id){...on Issue{projectItems(first:100){nodes{project{id}}}}}}',{id:issue.node_id});
      if(!result.node.projectItems.nodes.some(item=>item.project.id===project.external_id))throw new Fault(400,'issue_project_mismatch');
    } else {
      for(let page=1;page<=100;page++){
        const rows=await this.gh(token,`/repos/${repo}/issues?state=all&per_page=100&page=${page}`);
        issue=rows.find(i=>!i.pull_request && i.body?.includes(marker));
        if(issue || rows.length<100)break;
        if(page===100)throw new Fault(502,'issue_reconciliation_limit');
      }
      if(!issue)issue=await this.gh(token,`/repos/${repo}/issues`,{title:task.title,body:description});
      await this.gql('github',token,'mutation($project:ID!,$issue:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$issue}){item{id}}}',{project:project.external_id,issue:issue.node_id});
    }
    return {id:String(issue.number),url:issue.html_url};
  }
  async backfill(provider, token, project, task) {
    const marker=`<!-- progressive-agent:${task.id}:pr -->`;
    const body=[`开发结果：${task.result.pr}`,`测试通过：${task.result.tests}`,`提交：${task.result.commit}`,`运行：${task.result.runUrl}`,'草稿 PR 已创建，等待代码审阅。',marker].join('\n\n');
    if(provider==='github'){
      for(let page=1;page<=100;page++){
        const rows=await this.gh(token,`/repos/${project.binding.repo}/issues/${task.original.id}/comments?per_page=100&page=${page}`);
        if(rows.some(r=>r.body?.includes(marker)))return;
        if(rows.length<100){await this.gh(token,`/repos/${project.binding.repo}/issues/${task.original.id}/comments`,{body});return;}
      }
      throw new Fault(502,'comment_reconciliation_limit');
    }
    const comments=await this.paginate(async cursor=>(await this.gql('linear',token,'query($id:String!,$cursor:String){issue(id:$id){comments(first:100,after:$cursor){nodes{body}pageInfo{hasNextPage endCursor}}}}',{id:task.original.id,cursor})).issue.comments);
    if(comments.some(c=>c.body?.includes(marker)))return;
    const result=await this.gql('linear',token,'mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}',{input:{issueId:task.original.id,body}});
    if(!result.commentCreate.success)throw new Fault(502,'backfill_failed');
  }
}
