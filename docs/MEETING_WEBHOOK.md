# 会议纪要 Webhook Connector

适用于提供纪要与待办导出或自动化回调的会议平台。它不是某个会议厂商的原生 OAuth Connector，也不会绕过该平台的访问权限。

在工作台 → Connectors → 会议纪要 Webhook 创建端点。保存只显示一次的 Bearer 密钥；轮换立即作废旧密钥，断开停止接收和新派发。每个账号独立密钥、项目和执行 Agent，无需飞书授权。密钥只用于此接收端点及本端点的事件状态查询，不具备工作台管理权限。

## 发送纪要

POST 创建的端点，Content-Type: application/json，Authorization: Bearer <密钥>。应由会议服务端或可信集成工具发送，密钥不要放在前端页面或公开仓库中。

```json
{
  "externalId": "provider:meeting-unique-id",
  "title": "Relay Desk 与 Sprint Desk 周会",
  "url": "https://meeting.example/meeting-unique-id",
  "todos": [
    {"id": "todo-1", "content": "Relay Desk 实现高优先级只读总数。"}
  ],
  "notes": [
    {"id": "summary", "kind": "summary", "text": "Relay Desk：只统计原始数据中 priority 等于 high 的数量，空数组为零。不添加筛选按钮或搜索。"}
  ]
}
```

`todos` 1–100 条，ID 唯一、每条最多 6000 字符。`notes` 可为空数组，最多 100 条，只支持 `summary` / `chapter`，ID 不得以 `todo:` 开头。两者合计最多 100000 字符。纪要必须是真实会议资料，不能让模型或发送方把猜测当作已确认内容。待办与纪要是来源证据，不是执行指令。

202 响应返回 `eventId`、`state` 与 `duplicate`。接收确认表示已持久化，随后由 Cloudflare Queue 和 BigModel Managed Agent 在云端处理。发送失败可用完全相同的数据及 `externalId` 重试。相同 ID 和内容不会重复抽取或开发；同一账号下，同一 HTTPS 会议链接从不同事件 ID 或 Connector 再次送达，也会复用已完成抽取的任务（飞书妙记链接会忽略来源参数）。请提供唯一且稳定的会议链接，不要使用会议列表首页。相同 ID 配不同内容返回 409 `meeting_event_conflict`，不会覆盖已运行需求。重新讨论后的需求请使用新的会议 ID。

项目由待办自身的项目名称/用户设置的别名优先匹配，不能被模型猜测或多项目会议标题覆盖。没有唯一归属则等待项目确认。纪要只补全该待办的已确认条件，未决/冲突/证据不足则暂停并提示澄清。模型遗漏的待办仍保留为待澄清条目，不静默丢弃。

## 查询处理结果

GET `<接收端点>/<eventId>`，携带相同 Bearer 密钥。仅返回该端点对应事件的状态、任务、澄清原因、原需求和 PR 链接，不返回其他账号资料或密钥。初始 `state=queued`，完成抽取后 `completed`；任务状态继续反映开发进度。接入方按需轮询查询结果，当前版本不向任意回调 URL 推送结果。

自动开发仍需授权 GitHub 或 Linear、绑定 Repo 与 BigModel Agent，并安装云端执行器。一个任务只有在独立测试、变更范围及需求证据复核通过后才创建草稿 PR，回填到所属项目的原需求。工作台与云端定时检查不依赖本地 Mac 常驻进程。
