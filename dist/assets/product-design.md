# Progressive Agent 开源产品设计

2026-11-19 · 产品设计提案

## 定位与首批用户

Progressive Agent 是开发团队的会议执行层。它将会议里的明确行动项整理成带原文依据的任务，匹配项目与代码仓库，交给已配置的 Agent，在独立分支里开发并运行测试，最后把 PR 和成果写回原任务。

首批服务独立开发者、两到十人的产品研发团队、在多个项目间工作的技术负责人。用户授权会议来源，配置项目及 Agent 后，日常从熟悉的会议和聊天工具发起工作。

首个可用版本以飞书妙记、GitHub、BigModel Managed Agent 的已验证链路为落地起点。其他会议平台与执行器通过统一接口逐步接入。

## 产品承诺与边界

- 每条待办都能回到来源会议和原话。缺少验收标准或项目归属时进入待确认状态。
- 项目绑定仓库、上下文资料、执行器、校验命令、授权策略。明确匹配成功才执行。
- 执行完成需要提交、校验结果和 PR 链接。代码任务以草稿 PR 作为首版交付。
- 原始逐字稿先经过无工具的抽取步骤。执行器只获得任务需要的原话片段、结构化需求和项目允许提供的上下文。
- 调度、队列、执行和回填可部署在云端。自托管版也支持本地 Agent，运行位置在项目设置中可见。
- 自动合并 PR、自动生产发布、自动回复外部客户分别需要额外的项目规则，首版交付范围为创建 PR 和结果回填。

## 核心使用流程

1. 连接会议来源。确认可访问范围、同步方式与历史回溯起点。
2. 从项目管理平台导入 Project，或手动建立。同步名称、描述、需求与来源链接，确认仓库、可用 Agent、上下文文档与校验命令。首次连接执行只读预检。
3. 会议结束后接收事件或定时发现。等待逐字稿完成，提取决定、待办和未决问题。
4. 逐条匹配 Project。按会议绑定、明确项目名、已知别名优先匹配，再由模型建议。多个项目都符合时请用户选择。
5. 判断可执行性。目标、验收、上下文与权限齐全的任务按项目策略进入队列。缺失信息通过原聊天渠道追问。
6. 执行。记录仓库基线，创建隔离工作副本与任务分支，分配 Agent，实时记录执行状态。
7. 校验。在隔离环境执行预先登记的校验命令，检查修改范围。失败反馈给同一次运行，超过重试或预算限制则暂停。
8. 交付。推送代码、创建或复用草稿 PR，任务写回成果、测试结果、提交与运行链接，在私聊通知用户。
9. 后续调度识别已完成任务，复用原结果。用户可在 Project 查看所有任务，也可从全局 Agent Tasks 找到对应 Project。

## 信息架构

### Projects

每个项目展示仓库与基线分支、资料、默认执行器、运行位置、可写路径、审批模式、预算、校验命令、近期任务与 PR。允许一个项目关联多个仓库，每条可执行任务必须落到一个明确仓库。

### Agent Tasks

全局任务列表按项目、来源、执行器和状态筛选。任务页聚合目标、验收条件、原话与时间戳、Project、运行记录、测试、提交、PR、回填状态。任务正文与输出保存在团队指定的文档系统，可替换 Feishu Docs。

### Connections

集中管理会议来源、Agent、代码托管和通知渠道。显示支持的能力、授权范围、最近同步时间、凭据有效性、健康状态和重试错误。

### Runs

每次尝试有独立 Run。任务失败后保留已有提交与错误，恢复时从确定的检查点继续。停止、重试和审批都有操作记录。

## 数据模型

| 实体 | 核心字段 |
| --- | --- |
| Workspace | id、成员、连接器、项目策略、数据保留配置 |
| Connection | id、provider、identity、credentialRef、capabilities、cursor、health |
| Meeting | id、sourceConnectionId、externalId、title、timestamps、transcriptRevision、readiness |
| Evidence | meetingId、speaker、startMs、endMs、quote、basis |
| ActionItem | id、meetingId、evidenceIds、title、goal、acceptance、assignee、dueAt、missingInfo |
| Project | id、name、aliases、repositoryBindings、contextRefs、agentBinding、policy |
| RepositoryBinding | provider、repositoryId、baseBranch、allowedPaths、validationCommands |
| Task | id、actionItemId、projectId、repositoryId、specRevision、state、idempotencyKey |
| Run | id、taskId、agentBindingId、baseCommit、attempt、checkpoint、usage、state |
| Artifact | taskId、runId、type、url、commitSha、verification |
| Delivery | taskId、destinationId、artifactId、externalMessageId、state、idempotencyKey |

Project、Task、Run、Artifact 通过稳定 ID 关联。任务更换项目或需求发生实质变化时创建新修订，执行前再次确认仓库与策略。

## 状态与恢复

Meeting 状态为 discovered、waiting_transcript、ready、normalized、failed。

Task 状态为 proposed、needs_project、needs_info、ready、queued、running、awaiting_approval、verifying、completed、failed、cancelled。

Run 拆分为 claimed、workspace_ready、executing、validated、branch_pushed、pr_created、backfilled。Task 仅在交付完成并可读回确认后完成。执行器不可用时保留任务和恢复位置。

领取任务使用数据库唯一约束与可续期租约。任务的稳定键由工作区、来源 ID、会议修订、原话定位和归一化任务目标组成。创建远端会话时先登记派发意图，再用任务标记查回会话，避免在响应丢失后盲目重建。

PR 分支由 Task ID 决定。推送后恢复直接查询原分支与 PR。文档追加与通知使用独立幂等键。测试、推送和回填的状态分别持久化，回填失败重做回填。

来源同步同时支持 webhook 和 polling。使用游标加回溯窗口覆盖搜索收录延迟。重复会议通过来源 ID 去重，逐字稿更新按修订处理。每个工作区分别存储游标和授权身份。

## 连接器契约

以下是目标接口草案，迁移时兼容已有 InputSource、AgentAdapter、AgentPolicy 和 AgentRunResult。

### MeetingSource

- capabilities() 声明 webhook、poll、transcript、timestamps、speakerIds。
- discover(cursor, window) 返回会议引用、下一游标和就绪状态。
- transcript(meetingRef) 返回规范化片段、修订和来源。
- validateWebhook(request) 验签并解析来源事件。
- health() 反映权限与同步状态。

### AgentExecutor

- capabilities() 声明 repoEdit、resume、cancel、approval、artifacts。
- preflight(project, task) 检查认证、执行环境与项目能力。
- start(taskSpec, projectContext, workspaceRef, idempotencyKey) 创建或复用执行。
- events(runRef, cursor) 返回增量日志、审批与检查点。
- resume(runRef, decision)、cancel(runRef)、collect(runRef) 支持续接、停止、成果收集。

### ProjectSource

- listProjects(cursor)、getProject(ref) 同步可读项目与来源链接。
- listWorkItems(projectRef, cursor)、getWorkItem(ref) 获取需求、状态与原始字段。
- changes(cursor)、validateWebhook(request) 按能力处理增量事件与周期性对账。
- capabilities()、health() 声明读写、字段、实例版本、授权与同步健康状态。
- 外部任务写入与成果回填复用 DeliverySink，显式申请写入权限。

### RepositoryProvider

- resolveRepository()、checkout(baseCommit)、createTaskBranch()。
- validatePatch(allowedPaths)、pushCommit()、ensurePullRequest(taskKey)。
- readChecks() 返回仓库 CI 结果。

### DeliverySink

- upsertTask(taskKey, payload) 创建或更新来源任务。
- attachArtifact(taskKey, artifact) 回填结果。
- notify(taskKey, destination) 发回原会话，支持去重与失败补发。

每个连接器提供 manifest、权限清单、配置 schema、能力声明、契约测试和最小接入示例。平台的扩展点分别覆盖来源、执行器、仓库和回填，避免平台逻辑直接依赖某一家 API。

## 项目匹配

优先级为用户已绑定的会议系列、任务里明确提到的仓库、项目名与别名、模型建议。自动执行要求唯一目标，具备足够把握，并通过项目策略。

首次自动归类可建议新项目。一个新的可执行项目需要确认仓库、执行器与权限范围。暂时无法归属的任务进入 Inbox，保留原话并等待用户确认。多项目会议逐项归类。

已有云端试点按会议标题匹配单个已登记项目。逐任务匹配、跨仓库消歧和通用项目配置属于下一阶段。

## 项目来源与同步

建议按 GitHub Projects、Linear、Plane 的顺序实现项目来源。飞书项目按国内试点需求提前，Jira 在企业团队阶段接入。GitLab、OpenProject、Asana、Notion 和 TAPD 保留为后续候选。平台能力与选择理由见《项目来源平台选型》调研，GitHub Projects 和 Linear 的 OAuth、项目同步、项目匹配、BigModel 云端开发、独立测试、草稿 PR 和原需求回填已完成真实内测。多用户工作台通过 GitHub 登录，各自授权连接器和 Agent；第二位真实用户的跨账号全链路仍需本人授权验收。其余项目来源为规划。

通过 ProjectSourceBinding 将 connectionId、externalProjectId、externalUrl、localProjectId 与字段映射关联。外部名称、描述、负责人和业务状态由来源维护，本地仓库、Agent、校验与执行权限独立配置。一个看板可能包含多个仓库，每条任务仍须明确目标仓库。

首次导入只读取选择的项目；配置仓库、Agent 与策略后才能自动执行。写回需求、评论、PR 与状态需要额外写入授权。草稿 PR 对应待审阅，业务完成状态按合并或人工确认规则另行映射。

项目去重使用工作区、连接和外部 ID；改名不影响绑定。事件与分页对账结合，写回带来源标记避免触发自身更新循环。归档与撤权停止新派发，保留运行审计。

## 执行与凭据

项目默认人工确认。管理员可为指定来源、仓库和低风险修改开启自动执行，设置预算、时间上限和修改范围。人工批准改变任务允许的操作，并记录批准人和有效范围。

编码、校验、发布、回填分配独立身份。校验运行 Agent 生成的代码时，运行环境只具备校验所需权限。GitHub 发布优先使用 GitHub App 的短期仓库令牌。飞书用户令牌通过凭据库续期。日志、文档与仓库不记录密钥。

原文、附件和引用统一标为外部输入。项目上下文只发送给项目允许的执行器。记录数据经过的模型、执行位置和写入系统。撤销连接后停止后续同步和派发。

## 开源结构与部署

沿用 TypeScript monorepo，将已存在的 core、extract、intent、daemon 逐步收敛为 domain、sources、agents、repositories、deliveries、orchestrator 与 web。

当前开源首版使用 Cloudflare Workers、D1 和 Queues，每 5 分钟按用户排队检查，使用持久回执和租约防止重复执行。BigModel Managed Agent 开发代码，GitHub Actions 独立验证并由平台发布草稿 PR。本地预览使用 SQLite。PostgreSQL、事务 outbox、更多执行器和部署后端为后续扩展。

建议 Apache-2.0 作为核心许可，支持团队自托管与商业集成。当前仓库为私有且尚未附许可证，选定许可、完成凭据与样例数据清理后再公开。官方连接器随核心发布，社区连接器遵循同一契约并单独声明维护者。

## 发布顺序

### 首版

- 飞书妙记、录音或标准逐字稿输入。
- GitHub 项目、明确的项目归属与任务验收。
- BigModel Managed Agent，加上现有 Claude Code 适配路径。
- 隔离工作副本、测试、草稿 PR、Feishu Docs 与私聊回填。
- 单工作区部署，状态、取消、失败重试、预算与审计。
- 可运行的 Focus Board 示例和契约测试。

### 后续

- Codex、更多 CLI / HTTP 执行器，任务级恢复与能力协商。
- Zoom、Google Meet、Teams 等官方接口连接器，逐个验证访问与转写权限。
- 多项目会议的任务级匹配，多仓库项目，GitLab。
- 通用通知与文档回填，Slack、Teams 等渠道。
- 多工作区与组织身份，部署向导与连接器开发工具。

## 已有证据与待验证项

已验证飞书妙记从合成录音转写、自动查询、草稿写入 Project、Agent Tasks 登记和私聊回传。Focus Board 的新会议已自动触发 GitHub Actions，BigModel 改代码，GitHub-hosted Ubuntu runner 通过 12 项测试，创建草稿 PR 并写回飞书任务。

当前云端开发接力仅绑定 Focus Board，通用配置、多租户、所有第三方连接器和各执行器组合仍需产品化。已有试点的分页上限、远端会话创建的崩溃恢复窗口和凭据授权范围需按上述状态机收敛并验证。Mac 本机接力停用时云端链路通过，物理关机尚未实测。

## 验收标准与指标

- 每个完成的任务可追溯到来源、Project、仓库基线、Run、校验和 PR。
- 不匹配的项目、过期凭据与待补充需求均有明确状态和可恢复入口。
- 相同来源重放两次只产生一个任务、一条任务分支、一个 PR 和一次完成通知。
- 代码任务在校验通过前无法进入发布阶段。
- 在本机接力停用后，用新的会议从来源同步完整运行至回填。
- 跟踪来源就绪到任务可用、可执行任务占比、项目匹配人工修正率、测试通过率、每个有效 PR 的成本、重复副作用数与回填成功率。首版先记录基线，再确定目标。
