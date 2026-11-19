const descriptions = [
  '会议结束后，同步可读逐字稿，保留发言人与原话。',
  '任务匹配到项目与仓库，整理目标、约束和验收条件。',
  'Agent 在独立工作副本中开发，执行项目登记的测试。',
  '生成草稿 PR，把成果链接写回任务和原会话。',
];
const steps = [...document.querySelectorAll('[data-step]')];
const panel = document.querySelector('#flow-panel');
const previous = document.querySelector('#demo-prev');
const next = document.querySelector('#demo-next');
const replay = document.querySelector('#demo-replay');
let current = 0;
let timer;
let playing = false;

function showStep(index) {
  current = index;
  panel.dataset.current = String(index);
  steps.forEach((button, position) => {
    button.classList.toggle('active', position === index);
    button.classList.toggle('completed', position < index);
    button.setAttribute('aria-selected', String(position === index));
    button.tabIndex = position === index ? 0 : -1;
  });
  panel.setAttribute('aria-labelledby', steps[index].id);
  document.querySelector('#stage-description').textContent = descriptions[index];
  document.querySelector('#demo-position').textContent = steps[index].querySelector('span:last-child').textContent;
  previous.disabled = index === 0;
  next.disabled = index === 3;
  panel.querySelectorAll('.stage-focus').forEach(element => element.classList.remove('stage-focus'));
  const target = panel.children[Math.min(index, 2)];
  void target.offsetWidth;
  target.classList.add('stage-focus');
}
function stopReplay() {
  window.clearTimeout(timer);
  playing = false;
  replay.innerHTML = '<span aria-hidden="true">↻</span> 重播';
}
function selectStep(index) {
  stopReplay();
  showStep(index);
}
steps.forEach((button, index) => {
  button.addEventListener('click', () => selectStep(index));
  button.addEventListener('keydown', event => {
    const movement = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!movement && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + movement + 4) % 4;
    selectStep(target);
    steps[target].focus();
  });
});
previous.addEventListener('click', () => selectStep(Math.max(0, current - 1)));
next.addEventListener('click', () => selectStep(Math.min(3, current + 1)));
replay.addEventListener('click', () => {
  if (playing) {
    stopReplay();
    return;
  }
  playing = true;
  showStep(0);
  replay.innerHTML = '<span aria-hidden="true">Ⅱ</span> 暂停';
  const advance = () => {
    if (current === 3) {
      stopReplay();
      return;
    }
    showStep(current + 1);
    timer = window.setTimeout(advance, 2600);
  };
  timer = window.setTimeout(advance, 2600);
});
showStep(0);

const providers = {
  sources: [
    ['F', '飞书妙记', '自动发现新会议待办与纪要依据', '已验证', true],
    ['↳', '会议纪要 Webhook', '接收其他会议来源，保留证据与去重', '已验证', true],
    ['D', '钉钉听记', '已有适配与离线提取样例', '待完整联调', false],
    ['G', 'Zoom / Google Meet / Teams', '通过来源适配器接入', '规划中', false],
    ['T', '录音与逐字稿', '统一转成可提取的会议片段', '已有实现', false],
  ],
  projects: [
    ['⑂', 'GitHub Projects', '项目看板与 Issue，衔接代码交付', '已验证', true],
    ['L', 'Linear', '项目、需求与 Agent 协作上下文', '可连接', false],
    ['G', 'GitLab Issues', '同步项目，绑定 GitHub Repo 与 Agent', '待真实账号验收', false],
    ['P', 'Plane', '面向开源社区与自托管团队', '规划中', false],
    ['F', '飞书项目', '空间、工作项与团队流程', '规划中', false],
    ['J', 'Jira', '企业研发项目与自定义工作流', '后续候选', false],
  ],
  agents: [
    ['B', 'BigModel Managed Agent', '云端编码、测试与成果收集', '已验证', true],
    ['C', 'Claude Code', '已有本机执行器与项目上下文', '已有适配', false],
    ['O', 'Codex', '计划接入的编码执行器', '规划中', false],
    ['+', 'CLI / HTTP Agent', '实现执行、事件与成果契约', '接口规划', false],
  ],
  delivery: [
    ['⑂', 'GitHub', '任务分支、独立校验与草稿 PR', '已验证', true],
    ['▤', 'Feishu Docs', '项目目录、Agent Tasks 与结果回填', '已验证', true],
    ['F', '飞书私聊', '授权入口与成果通知', '已验证', true],
    ['G', 'GitLab Issues', '回填 GitHub PR 与测试结果', '契约测试通过', false],
    ['+', 'Slack / Teams', '通过成果通知适配器扩展', '规划中', false],
  ],
};
const connectorTabs = [...document.querySelectorAll('[data-connector]')];
function showConnectors(category) {
  connectorTabs.forEach(button => {
    const selected = button.dataset.connector === category;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  const container = document.querySelector('#connector-list');
  container.replaceChildren(...providers[category].map(([symbol, title, note, status, verified]) => {
    const row = document.createElement('div');
    row.className = 'connector-row';
    const icon = document.createElement('span');
    icon.className = 'connector-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = symbol;
    const text = document.createElement('div');
    const name = document.createElement('strong');
    const detail = document.createElement('small');
    name.textContent = title;
    detail.textContent = note;
    text.append(name, detail);
    const tag = document.createElement('span');
    tag.className = 'connector-status' + (verified ? ' verified' : '');
    tag.textContent = status;
    row.append(icon, text, tag);
    return row;
  }));
}
connectorTabs.forEach((button, index) => {
  button.addEventListener('click', () => showConnectors(button.dataset.connector));
  button.addEventListener('keydown', event => {
    const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!move) return;
    event.preventDefault();
    const target = connectorTabs[(index + move + connectorTabs.length) % connectorTabs.length];
    showConnectors(target.dataset.connector);
    target.focus();
  });
});
showConnectors('sources');

const agentToggle = document.querySelector('#agent-toggle');
const agentMenu = document.querySelector('#agent-menu');
function closeAgents() {
  agentMenu.hidden = true;
  agentToggle.setAttribute('aria-expanded', 'false');
}
agentToggle.addEventListener('click', () => {
  agentMenu.hidden = !agentMenu.hidden;
  agentToggle.setAttribute('aria-expanded', String(!agentMenu.hidden));
  if (!agentMenu.hidden) agentMenu.querySelector('button').focus();
});
let toastTimer;
document.querySelectorAll('[data-agent]').forEach(button => {
  button.addEventListener('click', () => {
    agentToggle.firstChild.textContent = button.dataset.agent + ' ';
    closeAgents();
    agentToggle.focus();
    const toast = document.querySelector('#toast');
    toast.textContent = '演示执行器已切换为 ' + button.dataset.agent + '，此页面使用示例数据。';
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3600);
  });
});
document.addEventListener('click', event => {
  if (!event.target.closest('.agent-choice')) closeAgents();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !agentMenu.hidden) {
    closeAgents();
    agentToggle.focus();
  }
});
