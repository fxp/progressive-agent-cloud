# GitLab Issues Connector

当前支持 GitLab.com，作为项目与需求来源；代码仍交给 BigModel Managed Agent 在绑定的 GitHub Repo 开发，通过独立 GitHub Actions 测试后创建草稿 PR，再回填 GitLab Issue。不支持 GitLab 仓库执行器、Merge Request 或自托管 GitLab 实例。

在 Connectors → GitLab Issues 输入自己的 Personal Access Token，需含 `api` 权限。服务先验证 Token 身份和权限，再加密保存并同步成员可访问、未归档且启用 Issues 的项目。GitLab Token 不会出现在前端状态或仓库执行器中。Token 到期或撤销会要求重新连接；未先断开连接时不能覆盖为另一个 GitLab 账号。

连接后，为项目设置会议中使用的别名，并绑定 GitHub Repo、BigModel Agent、允许修改的路径和测试命令。会议中明确的待办会在 GitLab 对应项目创建来源 Issue；通过测试及需求证据检查后，PR、提交和运行链接回填到该 Issue。创建和回填都使用任务标记进行恢复，重复扫描或响应丢失后的重试会复用已存在的 Issue 和评论。当前不接受直接指定既有 GitLab Issue URL，以避免未经核验的跨项目回填。

项目同步读取所有分页后再原子更新。刷新失败保留旧项目目录与绑定；项目改名保留绑定，归档或不再可读的项目停止后续派发。

验证状态：本版本已通过 API 契约及故障恢复测试；尚未使用真实 GitLab 账号完成授权到回填验收。会议 Webhook → GitHub Projects → BigModel → GitHub PR 链路另有真实云端验收记录。请勿把 GitLab Connector 的契约测试当作真实账号验收。

官方接口依据：[Projects API](https://docs.gitlab.com/api/projects/)、[Issues API](https://docs.gitlab.com/api/issues/)、[Notes API](https://docs.gitlab.com/api/notes/)、[Token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)。
