# 项目来源平台选型

2026-11-19 · 官方文档调研与接入建议

## 建议与顺序

建议先实现 GitHub Projects，再实现 Linear，随后用 Plane 验证自托管接入。飞书项目按国内试点需求提前；Jira 放在企业团队阶段。这个顺序是基于当前 GitHub 交付链路、研发团队的项目模型和自托管目标作出的产品判断，尚未完成这些项目来源适配器的联调。

项目来源的职责是提供项目目录、需求、负责人、状态与上下文。Progressive Agent 负责把这些项目绑定到仓库、Agent 与执行策略。外部平台仍是项目与业务状态的权威来源，运行日志、测试结果和执行状态由 Progressive Agent 管理。

## 推荐平台

| 平台 | 可作为来源的对象 | 官方接入能力 | 推荐用途与边界 |
| --- | --- | --- | --- |
| GitHub Projects | ProjectV2、Issue、草稿项、自定义字段 | Projects API，组织项目与项目项事件 | 首个适配器。与现有仓库、PR 链路衔接；一个看板可能跨多个仓库。Projects webhook 当前针对组织项目且有预览限制，个人项目优先用轮询。 |
| Linear | Project、Issue、项目更新与文档 | GraphQL、OAuth、Project/Issue webhook、Agent 接入机制 | 首个独立项目平台适配器。适合产品研发团队；读取团队与权限范围，仓库绑定另行确认。 |
| Plane | Workspace 下的 Project、Work item、Cycle、Module | REST API、webhook、可配置自托管 API 地址 | 开源与自托管方向的优先候选。适配器按实例与 API 版本声明能力，不能默认云版和所有自托管版本一致。 |
| 飞书项目 | 空间、工作项、流程、字段与评论 | 开放平台数据接口、自动化连接器及工作项事件 | 国内飞书用户优先候选。先确认哪种工作项代表产品项目；飞书 Docs 中的 Project 目录与飞书项目是不同系统。 |
| Jira Cloud | Project、Issue、Issue type、字段、状态流转 | REST API v3、OAuth、动态 webhook | 企业研发团队候选。自定义字段和状态需要逐项目映射；REST 动态 webhook 有有效期，需要续订。Data Center 单独适配。 |

## 其他值得保留的候选

| 平台 | 适合场景 | 接入判断 |
| --- | --- | --- |
| GitLab | 使用 GitLab.com 或 Self-Managed 的研发团队 | 有 Projects API 与项目 webhook。Project 在代码托管侧通常对应仓库，需要额外建业务项目映射；MR 交付也应由 RepositoryProvider 配套实现。 |
| OpenProject | 需要自托管和层级项目管理的团队 | API v3 覆盖项目与工作包，支持项目、工作包等事件。需确认部署版本、workspace 类型与 API 覆盖范围。 |
| Asana | 产品、设计、运营共同参与的跨职能团队 | 有项目列表与 webhook。项目中可能包含非代码任务，需筛出可开发需求并绑定仓库；事件同步应保留轮询补偿。 |
| Notion | 已有 Projects/Tasks 数据库的小团队 | Data source 查询与 webhook 可用。需要先映射名称、状态、负责人和任务关系等字段；适合可配置模板来源。 |
| TAPD | 已使用腾讯研发协作工具的国内团队 | 官方有用户参与项目列表 API。API 属于商业化模块，授权与费用需由试点企业确认；放在有明确客户需求时接入。 |

暂不同时实现所有平台。首版用两个适配器验证统一契约，再扩展自托管与企业复杂流程。

## 产品中的接入体验

1. 连接平台并授权只读项目范围；自托管实例额外填写服务地址。
2. 列出可读项目，用户选择需要同步的项目。导入名称、描述、别名、成员、状态、来源链接与修订信息。
3. 从已有代码关联建议仓库，用户确认仓库、基线分支、Agent、校验命令与执行策略。未配置完整的项目可同步、不可自动派发。
4. 绑定会议系列、群聊或项目别名。会议中提取的每条待办独立匹配项目，存在多个候选时进入待确认。
5. 若会议明确引用已有需求，优先更新或关联原需求；新需求在开启写入授权后创建外部任务，并保存外部 ID。
6. Agent 执行完成，回写 PR、校验摘要和运行链接。创建草稿 PR 对应“待审阅”，不直接等同于业务任务“已完成”；合并或人工确认后再按映射流转。

## 统一契约与模型

新增 ProjectSource，与 MeetingSource、AgentExecutor、RepositoryProvider、DeliverySink 并列。

- capabilities()：声明 projectRead、workItemRead、workItemWrite、webhook、incrementalSync、customFields。
- listProjects(cursor)、getProject(ref)：分页读取用户可访问的项目与来源链接。
- listWorkItems(projectRef, cursor)、getWorkItem(ref)：读取需求及其项目、状态、原始字段。
- changes(cursor)、validateWebhook(request)：按平台能力处理增量、签名验证和权限事件；无增量接口时周期性分页对账。
- upsertWorkItem(taskKey, payload)、attachArtifact(ref, artifact)：写入范围显式授权，按能力拆分给 DeliverySink，复用同一连接身份。
- health()：检查认证、权限、实例版本、配额与 webhook 续订状态。

ProjectSourceBinding 保存 connectionId、externalProjectId、externalUrl、localProjectId、fieldMapping、lastRevision、lastSyncedAt。唯一键包含 workspaceId、connectionId、externalProjectId，自托管实例由独立 Connection 标识。

ExternalWorkItemBinding 保存 taskId、externalWorkItemId、externalUrl、externalProjectId 和写回标记。同一个内部 Project 可以关联多个外部来源，但只选择一个默认需求写入目标，避免同时复制出多套任务。

外部名称、描述与业务状态随来源更新；本地仓库、Agent、测试命令和执行权限独立维护。外部字段不能直接覆盖可执行命令或扩大权限。撤权或归档后停止新派发，保留已授权范围内的运行审计。

webhook 接收后重新读取可见资源，结合分页对账防止遗漏。写回记录 origin、任务 ID 和修订，过滤自身更新造成的循环。远端创建响应丢失时按稳定标记查找原任务；无法确认时进入对账状态，避免盲目重建。

## 首版验收

- 同一项目重复同步不重复创建；改名不丢失仓库绑定。
- 同名项目可按来源、团队和外部 ID 区分。
- 一个看板包含多个仓库时，未明确任务目标仓库不能自动派发。
- 只读授权可导入项目，无法创建或更新外部任务。
- 会议任务关联原需求，PR 和测试结果写回同一条需求。
- 重复事件与回填重试不重复建任务、不触发执行回环。
- 撤权、删除、归档、限流与 webhook 失效可见且可恢复。

## 官方资料

- [GitHub：使用 API 管理 Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [GitHub：Projects REST API](https://docs.github.com/en/rest/projects/projects)
- [GitHub：Webhook 事件与权限](https://docs.github.com/en/webhooks/webhook-events-and-payloads#projects_v2)
- [Linear：GraphQL API](https://linear.app/developers/graphql)
- [Linear：Webhook](https://linear.app/developers/webhooks)
- [Linear：Agent 接入](https://linear.app/developers/agents)
- [Plane：API](https://developers.plane.so/api-reference/introduction)
- [Plane：Webhook](https://developers.plane.so/dev-tools/intro-webhooks)
- [Plane：自托管](https://plane.so/self-hosted)
- [飞书项目：开放平台](https://project.feishu.cn/home/developers)
- [飞书项目：自动化连接器与事件](https://www.feishu.cn/content/ef835n76)
- [Jira Cloud：Projects API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/)
- [Jira Cloud：动态 Webhook](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/)
- [GitLab：Projects API](https://docs.gitlab.com/api/projects/)
- [GitLab：项目 Webhook](https://docs.gitlab.com/api/project_webhooks/)
- [OpenProject：API](https://www.openproject.org/docs/api/)
- [OpenProject：Webhook](https://www.openproject.org/docs/system-admin-guide/api-and-webhooks/)
- [Asana：项目列表 API](https://developers.asana.com/reference/getprojects)
- [Asana：Webhook 与补偿同步](https://developers.asana.com/docs/webhooks-guide)
- [Notion：查询 Data source](https://developers.notion.com/reference/query-a-data-source)
- [Notion：Webhook](https://developers.notion.com/reference/webhooks)
- [TAPD：用户参与项目列表](https://open.tapd.cn/document/api-doc/API文档/api_reference/workspace/user_participant_projects.html)
- [TAPD：API 使用必读](https://open.tapd.cn/document/api-doc/API文档/使用必读.html)
