# 开始使用 Progressive Agent

[打开工作台](https://progressive.xiaopingfeng.com/app)，直接使用 GitHub 登录。当前已开放注册，无需邀请、白名单或联系管理员开通产品账号。

## 接上第一条工作流

1. **登录 GitHub。** 首次登录会创建自己的工作区，并同步授权范围内可读的 GitHub Projects。项目和任务按用户隔离，其他用户不会继承你的授权或密钥。
2. **连接会议来源。** 在 Connectors 中选择“扫码开通飞书连接”，按页面完成应用创建与妙记待办授权。公司策略可能需要管理员审批；请使用会议所属组织。授权未获批时，页面会提示等待审批。其他会议系统可通过会议纪要 Webhook 提交待办与引用原文，格式见 [MEETING_WEBHOOK.md](MEETING_WEBHOOK.md)。
3. **连接项目管理。** GitHub Projects 使用登录时的 GitHub 授权；使用 Linear 的用户在 Connectors 中完成 Linear 授权并同步项目。请核对工作区、团队及应用可用范围。
4. **连接自己的 Agent。** 可选 BigModel Managed Agent、Codex CLI 或 Claude Code。填写自己可用的 API Key；Codex 与 Claude Code 还需填写对应协议的 HTTPS 模型地址和模型 ID。密钥加密保存，订阅登录不等同于云端 API 凭据。
5. **绑定 Repo。** 在 Projects 中选择一个项目，绑定自己有写权限的 GitHub Repo 和已连接的 Agent。确认项目别名、允许修改的文件与测试命令，保存并安装云端执行器。建议先用测试仓库。GitHub Actions 需要启用，一个仓库同一时间由一个项目管理。
6. **开一场新会议。** 扫码连接默认处理授权后生成的新妙记。说清项目名、具体功能和可观察的验收条件。系统每五分钟检查新会议，从原始待办与引用依据提取需求，匹配项目并交给云端 Agent。开发、独立测试和证据核对通过后，创建草稿 PR，并将链接回填原需求。

## 查看结果

在 Agent Tasks 查看会议来源、对应 Project、原需求、云端运行和 PR。需求缺少项目或验收依据时，会暂停并提示澄清；失败任务提供云端日志与恢复入口。重复处理同一会议会复用已有任务和交付记录。

PR 由你审阅后决定是否合并。工作台暂未自动同步合并后的任务状态，请以关联 PR 的实际状态为准。

托管服务的调度、开发和回填在云端运行，不依赖 Mac 常驻服务。公开注册不会授予飞书、GitHub、Linear 或模型服务中的额外权限；各连接器仍使用你本人授权的范围。

## 反馈与自部署

通过 [GitHub Issues](https://github.com/fxp/progressive-agent-cloud/issues/new/choose) 反馈问题，附上可公开的任务或运行 ID、版本和脱敏错误信息。不要提交 API Key、OAuth Token、保密会议内容或私有日志。

自部署见 [SELF_HOST.md](SELF_HOST.md)。部署者可选择公开注册或限制准入；可选的账号邀请机制见 [BETA_GUIDE.md](BETA_GUIDE.md)。
