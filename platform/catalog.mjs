export const catalog = [
  {id:'meeting-webhook', kind:'meeting', name:'会议纪要 Webhook', icon:'↳', description:'从其他会议平台接收纪要与待办，保留原文依据并自动匹配项目', auth:'webhook', capabilities:['meeting_todos','cited_notes','deduplicate','status']},
  {id:'feishu', kind:'meeting', name:'飞书妙记', icon:'F', description:'授权你自己的飞书账号，每 5 分钟发现可读的新妙记', auth:'oauth', capabilities:['discover','transcript','evidence']},
  {id:'github', kind:'project', name:'GitHub Projects', icon:'⑂', description:'同步项目与 Issue，绑定仓库并回填 PR', auth:'oauth', capabilities:['projects','issues','repositories','pull_requests']},
  {id:'linear', kind:'project', name:'Linear', icon:'L', description:'同步项目与需求，开发结果写回原 Issue', auth:'oauth', capabilities:['projects','issues','comments']},
  {id:'gitlab', kind:'project', name:'GitLab Issues', icon:'G', description:'同步 GitLab.com 项目，将 GitHub PR 与测试结果回填到项目 Issue', auth:'access_token', capabilities:['projects','issues','comments']},
  {id:'bigmodel', kind:'agent', name:'BigModel Managed Agent', icon:'B', description:'连接自己的 Agent 密钥，云端开发，独立测试并创建 PR', auth:'api_key', capabilities:['repo_edit','artifacts']},
];
export const oauthProviders = {
  feishu:{authorize:'https://accounts.feishu.cn/open-apis/authen/v1/authorize',token:'https://open.feishu.cn/open-apis/authen/v2/oauth/token',scope:'auth:user.id:read minutes:minutes.search:read minutes:minutes.transcript:export offline_access',setup:'https://open.feishu.cn/app'},
  github:{authorize:'https://github.com/login/oauth/authorize', token:'https://github.com/login/oauth/access_token', scope:'repo project workflow read:org offline_access', setup:'https://github.com/settings/applications/new'},
  linear:{authorize:'https://linear.app/oauth/authorize', token:'https://api.linear.app/oauth/token', scope:'read,issues:create,comments:create', setup:'https://linear.app/developers/oauth-2-0-authentication'},
};
