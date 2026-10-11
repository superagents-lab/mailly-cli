---
name: mailly
description: Use this skill whenever the user wants to send transactional or marketing email, inspect per-recipient Sent Messages or delivery status, manage Contacts or Audiences, manage versioned email templates and lifecycle Workflows, send/verify email verification codes, check Mailly account balance / consumption logs, manage sender domains, list or create Inbox addresses, read Inbox threads and messages, reply or forward with attachments, change read state, download attachments, or configure Inbox Webhooks through the Mailly CLI. Trigger phrases include "send an email", "发邮件", "群发邮件", "发件箱", "已发邮件", "联系人", "动态分群", "Audience", "邮件模板", "生命周期邮件", "Workflow", "发送验证码", "send verification code", "查 Mailly 余额", "Mailly 日志", "添加发件域名", "创建收件地址", "收件箱", "回复邮件", "收件 Webhook", "读取邮件正文", "send via mailly", or any task that should go through the user's Mailly account. Always use the `mailly` CLI instead of hand-crafted curl/HTTP requests so credentials, errors, and JSON parsing are handled consistently.
---

# Mailly CLI

Mailly 是一个邮件 SaaS（单封 / 批量邮件、验证码、SMTP 中继、统一美元用量计费）。本 Skill 教 Agent 如何通过 `mailly` 命令行调用 Mailly 的用户端 API。

## 何时使用

只要用户的请求落在以下场景之一，就用这个 Skill：

- 发送邮件（单封 / 批量 / 通知 / 群发）；
- 发送或校验邮箱验证码（注册 / 登录 / 找回密码场景）；
- 查询 Mailly 账户余额、按收件人归档的已发邮件或消费日志；
- 查看或申请发件域名；
- 创建/列出收件地址，读取会话和正文，回复或转发邮件，管理已读状态，下载附件，配置收件 Webhook；
- 创建/渲染/发布/测试发送版本化模板，上报生命周期事件、创建/发布/暂停 Workflow、查询联系人事件时间线和 Run；
- upsert/导入/suppress Contact，创建静态用户集或动态分群，预览并冻结 Campaign audience；
- 查询、创建和更新 Agent 档案，录入或更新用户 Skills；
- 用户提到「Mailly」「mailly.site」「mailly-cli」。

如果用户在自己的项目里要集成 Mailly，**使用 `mailly` CLI**，而不是自己拼 HTTP 请求。CLI 以 npm 包 `mailly-cli` 发布，源码在 https://github.com/superagents-lab/mailly-cli 。

## 前置检查

每次用本 Skill 前，按这个顺序确认环境：

1. `command -v mailly` 确认已安装。未安装时请用户运行 `npm install -g mailly-cli`（需要 Node.js 18+），不要替用户全局安装。
2. `mailly --version` 应为 `0.2.0` 或更高；版本过低时请用户运行 `npm install -g mailly-cli@latest`。
3. `mailly whoami --json` — 已登录且 API Key 有效。如果失败，停下来让用户跑 `mailly login <api-key>` 或设置 `MAILLY_API_KEY` 环境变量，**不要自己编一个 key 试**。
4. 发信前用 `mailly balance --json` 查看通用美元余额及 `included_emails_remaining`。套餐封数先使用，超额邮件每个实际收件人 $0.001；余额不足会返回 402。读取、起草及验证码校验不按邮件扣费。Free 也可充值，额度不足重试不能绕过限制。

## 通用约定

- **Agent 调用一律加 `--json`**：所有命令都支持，输出结构化 JSON 便于解析。
- 失败统一输出 `{"success":false,"error":"..."}` 并以非 0 退出码退出。
- 除默认的浏览器登录流程外，业务命令均为 non-interactive，可以安全在脚本里使用。
- 凭据来源优先级：`--api-key` 参数 > `MAILLY_API_KEY` 环境变量 > `~/.mailly/config.json`。
- Base URL 默认 `https://api.mailly.site`，可通过 `--base-url` 或 `MAILLY_BASE_URL` 覆盖。

## 命令速查

### 账号

```bash
mailly login                          # 默认：开浏览器走 mailly.site 授权（device code flow）
mailly login --no-browser             # 不开浏览器，只打印授权 URL（远程/无图形环境）
mailly login --resume <device-token>   # 续办 login --json 发起的浏览器授权
mailly login <api-key>                # 直接粘贴 API Key（CI 友好）
mailly logout                         # 删除本地配置
mailly whoami --json                  # 当前 Key（脱敏）+ Base URL + 余额
mailly balance --json                 # 仅查余额：{"success":true,"balance":N}
```

**Agent 别替用户登录** — 登录涉及用户在浏览器里点「授权」按钮，Agent 完全没法代办。如果 `mailly whoami` 失败（401/未配置），停下来让用户自己跑 `mailly login`，**不要**自己拼 API Key 试。

### Agent 档案与用户 Skills

```bash
mailly agents list --json
mailly agents show <agent-id> --json
mailly agents create --name "客服助理" --mode draft --address-id <address-id> --json
mailly agents create --name "新助理" --persona-file ./persona.md --skills-file ./skills.json --json
mailly agents update <agent-id> --name "新的名称" --mode summarize --json
mailly agents update <agent-id> --skills-file ./skills.json --json
mailly agents update <agent-id> --skills-file - --json < ./skills.json
mailly agents update <agent-id> --unbind-address --json
mailly agents update <agent-id> --clear-skills --json
```

创建时只要求 `--name`；省略模式默认为 `off`，Skills 默认为空。更新只提交明确提供的字段，省略 Skills、人设、白名单或地址时保留原值。`--mode` 支持 `off / summarize / draft`。

- `--persona <text>` 或 `--persona-file <path>`：人设与业务说明，文件为 UTF-8，路径 `-` 读 stdin；`--persona ""` 清空。
- `--address-id <id>`：绑定收件地址；更新时 `--unbind-address` 解除绑定。
- `--allowed-senders <senders...>`：替换白名单，支持邮箱或 `@域名`；更新时 `--clear-allowed-senders` 清空，允许全部发件人。
- `--skills-file <path>`：读取 JSON 数组，**整体替换**该 Agent 的 Skills；`[]` 或更新时 `--clear-skills` 删除全部。修改单个技能时应保留文件中的其他技能及其 ID。两个文件选项不能同时读 stdin。

技能全部由用户录入。文件中每项字段为 `id / name / description / instructions / enabled`，例如以下格式示意（请填写自己的内容）：

```json
[
  {
    "id": "my-skill",
    "name": "填写技能名称",
    "description": "填写何时应使用这个技能",
    "instructions": "# 填写你的处理规则\n\n这里支持 Markdown。",
    "enabled": true
  }
]
```

`id` 是稳定标识，使用小写字母、数字和单个连字符分隔，最多 64 字符且不可重复；更新正文时保留 ID。最多 20 个技能，名称最多 100 字符，适用说明最多 900 字符，正文最多 16,000 字符，总内容最多 64,000 字符。`enabled: false` 停用并保留正文。服务端统一验证技能字段。

`list/show --json` 保留 API 返回结构，技能保存在 `skills_json` 字符串中。导出某个 Agent 的技能用于编辑：

```bash
mailly agents show <agent-id> --json | jq '.agent.skills_json // "[]" | fromjson' > skills.json
```

Skills 接口依赖服务端迁移 `0038_agent_skills.sql` 和配套代码；目标 Server 尚未升级时，请先升级服务端或指向本地 Server 验证。

### 发送邮件

首次执行 Marketing 发送前先检查 Workspace Footer 配置：

```bash
mailly marketing-settings show --json
mailly marketing-settings set \
  --brand-name "Search1API" \
  --postal-address "有效的实体邮寄地址" \
  --json
```

`settings` 为空时必须让用户提供真实品牌名称和有效邮寄地址，不能由 Agent 猜地址。Mailly 会自动生成 HTML table/inline-style 与纯文本 Footer，退订入口统一显示 `Unsubscribe from non-essential emails`；调用方不能移除退订入口。该 Workspace 级退订会停止产品更新、使用引导、促销等非必要邮件，但账号、账单、安全和购买回执等必要服务邮件仍会发送。配置属于 Workspace，只需设置一次。

单封 HTML：
```bash
mailly send \
  --to user@example.com \
  --subject "Hello" \
  --from-email noreply@yourdomain.com \
  --from-name "Your Brand" \
  --html "<p>Hi there</p>" \
  --json
```

带普通附件或 cid: 内嵌图片的单收件人直发：

```bash
mailly send \
  --to user@example.com \
  --subject "附件与内嵌图片" \
  --from-email noreply@yourdomain.com \
  --html '<p>Logo: <img src="cid:logo-1"></p>' \
  --text "Logo 与报告见邮件正文和附件" \
  --attachment ./report.pdf \
  --inline logo-1=./logo.png \
  --json
```

`--attachment` / `--inline` 可重复，最多 10 个、解码后合计不超过 6MB。普通附件（`--attachment`）只支持单个 `--to` 的非 Campaign 直发；`--inline` 必须同时提供 HTML。

Campaign / 群发要放图片时用 `--inline`，并且必须带 `--campaign-key`：

```bash
mailly send \
  --audience newsletter-subscribers \
  --subject "8 月产品更新" \
  --from-email news@yourdomain.com \
  --html-file ./body.html --text-file ./body.txt \
  --marketing --campaign-key product-update-2026-08 \
  --inline hero=./hero.png \
  --json
```

Campaign 内嵌图片按 Campaign 存一份，队列消息里只带引用（CF Queues 单条消息上限 128KB），发送前才组装进 MIME。约束：

- 只接受图片（`image/*`），最多 10 张、解码后合计不超过 1MB；
- 每张图片的 content-id 必须在 HTML 里用 `cid:<content-id>` 真正引用到，否则返回 400；
- 图片集合和主题/正文一样按 campaign key 冻结：同一 key 再次发送必须带完全相同的图片，换图返回 409；
- Campaign 进入 `completed` / `canceled` 后图片会被清理，之后不能再补发。

批量（多个 `--to`，自动入队）：
```bash
mailly send \
  --to a@x.com --to b@x.com --to c@x.com \
  --subject "通知" \
  --from-email noreply@yourdomain.com \
  --html-file ./body.html \
  --json
# 响应包含 provider_response.taskId，用于查询进度
```

生命周期/营销邮件必须显式分类，并建议先 dry-run：
```bash
mailly send \
  --to a@x.com --to b@x.com \
  --subject "产品更新" \
  --from-email noreply@yourdomain.com \
  --html-file ./body.html --text-file ./body.txt \
  --marketing --campaign-key product-update-2026-07 \
  --topic product_updates \
  --dry-run --json
```
确认 `inputCount`、`duplicateCount`、`invalidCount`、`unsubscribedCount`、`alreadySentCount`、`campaignClaimedCount`、`eligibleCount` 和 `requiredEmailUnits` 后，使用**完全相同的 `--campaign-key`**移除 `--dry-run` 才正式发送。非事务邮件会自动应用 workspace 全局偏好/suppression，并在 HTML 和纯文本版本注入退订链接；不要自行移除。

正式发送前可先做 Campaign 测试发送：

```bash
mailly send \
  --to internal-reviewer@yourdomain.com \
  --subject "产品更新" \
  --from-email noreply@yourdomain.com \
  --html-file ./body.html --text-file ./body.txt \
  --marketing --campaign-key product-update-2026-07 \
  --campaign-name "Search1API 2026-07 产品更新" \
  --frequency-cap-days 7 --frequency-cap-max 2 \
  --recipient-reason "You receive product updates from Search1API." \
  --test-send --json
```

测试发送仍会检查 suppression/退订并计入实际收件人邮件用量，但不会写入正式 recipient 幂等账本，也不会受 Campaign 频控。测试确认后，正式发送必须复用完全相同的 `--campaign-key`、发件人、主题、正文和频控设置，移除 `--test-send`。同一 key 的不可变内容不一致时服务端返回 `409`，Agent 不得偷偷换 key 绕过。

Marketing Footer 的品牌、邮寄地址和 `--recipient-reason` 也会在 Campaign 首次创建时冻结。Workspace 配置后续变更不会静默改变已存在 Campaign；如果正式发送与 test send 的 Footer 内容不一致，服务端返回 `409`。

`--campaign-key` 是业务幂等键：同一 Mailly workspace 下，同一 campaign key + 同一邮箱只允许一次业务发送。人工重跑、脚本重试或拆批时必须复用原 key。`alreadySentRecipients` 只列出已完成投递的地址；排队中、发送中或已终止等全部占位记录在 `campaignClaimedRecipients`，都不会再次入队。

正文形式（HTML / 纯文本 / multipart）：

| 场景 | 怎么传 | 实际 Content-Type |
|---|---|---|
| 只发 HTML | `--html` 或 `--html-file` | `text/html` |
| 只发纯文本 | `--text` 或 `--text-file` | `text/plain` |
| **同时给两份**（推荐用于群发，反垃圾邮件分数更好） | `--html ... --text ...` | `multipart/alternative`，客户端自选 |

注意事项：
- `--to` 可重复多次或用逗号分隔（`--to "a@x.com,b@x.com"`）。普通发送两个及以上收件人会走批量队列；正式 Campaign 即使只有一个收件人也会走 Queue，以便暂停/取消。
- `--html` / `--html-file` / `--text` / `--text-file` 至少给一组；也可以通过 stdin 把 HTML 管道进来：`cat body.html | mailly send --to ... --json`（stdin 默认当成 HTML）。
- 群发推荐 **同时传 `--html` 和 `--text`**：很多反垃圾系统会对「只有 HTML 没有纯文本版本」扣分，且 Apple Watch 通知、屏幕阅读器等也只读纯文本。
- 服务通知用默认的 `--email-type transactional`；商业内容必须用 `--marketing --campaign-key <稳定键>`，并先 `--dry-run` 复核受众。
- `--from-email` 必须使用 `outboundStatus: verified` 的域名（用 `mailly domains list --json` 查询）。
- 每个 To/Cc/Bcc 收件人计一封；先扣套餐邮件封数，超额按每封 $0.001 扣通用赠送余额，再扣充值余额。
- `mailly send` 支持两种变量替换，token 语法都是 `{{name}}`：
  - 自带正文时用 `--var name=value`（可重复）或 `--variables vars.json`，服务端在治理逻辑之前完成替换；正文里出现的每个 token 都必须有值，否则返回 400，不会把 `{{name}}` 原样发出去。HTML 正文里的值会做转义。
  - 复用已发布模板时用 `--from-template <template-key>`（可选 `--template-version N` / `--template-draft` / `--locale`），主题、正文、发件人、邮件类型、Topic、频控都取自模板，`--subject`、`--from-email` 等显式参数优先；正式版本会自动记录 templateKey/templateVersion。
  - Campaign 存的是替换后的正文，因此同一 `--campaign-key` 重发必须给相同的变量值，否则按不可变字段冲突返回 409。

带变量的发送：

```bash
# 自带正文 + 行内变量
mailly send \
  --to user@example.com \
  --subject "Hi {{name}}" \
  --from-email noreply@yourdomain.com \
  --html '<p>Hi {{name}}, 本月用量 {{usage}}</p>' \
  --var name=Ada --var usage=1200 \
  --json

# 用已发布模板渲染后发送
mailly send \
  --to user@example.com \
  --from-template welcome-email \
  --variables ./vars.json \
  --locale zh-CN \
  --json
```

### 查询批量任务进度

```bash
mailly status <taskId> --json
# 输出 status / totalEmails / processedEmails / successfulEmails / failedEmails / skippedEmails
# 状态: QUEUING / PROCESSING / COMPLETED_SUCCESSFULLY / COMPLETED_WITH_FAILURES
```

如果用户希望「等到发完再告诉我」，每隔 10–30 秒轮询一次 `mailly status`，直到 status 以 `COMPLETED_` 开头。**不要用过密的轮询**（< 5 秒）。

### 查询与恢复订阅

```bash
mailly preferences show recipient@example.com --json
mailly preferences resubscribe recipient@example.com \
  --scope workspace \
  --source support_ticket \
  --consent-at 2026-07-16T03:15:00Z \
  --consent-reference ticket-1234 \
  --json
```

- 只有用户已经明确重新同意时才能执行 `resubscribe`；`--source`、`--consent-at` 和可审计的 `--consent-reference` 都是必需证据，不能由 Agent 编造。
- 同一同意事件的重试必须复用完全相同的 reference、source 和 consent timestamp，服务端会幂等返回且不重复写审计。
- 该命令会原子恢复 Workspace preference 与 `unsubscribed` suppression，不要手工组合底层 preference/suppression API。
- `hard_bounce`、`complaint` 和 `manual` 不能走普通 resubscribe。前两者需要邮箱有效性证明或人工审核；`manual` 需要受控管理员流程。

### Campaign 查询与控制

```bash
mailly campaigns list --json
mailly campaigns create --file campaign.json --json
mailly campaigns show <campaign-key> --json
mailly campaigns audience <campaign-key> --json
mailly campaigns pause <campaign-key> --json
mailly campaigns update-content <campaign-key> --subject "修正后的主题" --html-file ./body.html --json
mailly campaigns resume <campaign-key> --json
mailly campaigns cancel <campaign-key> --json
mailly campaigns recipients <campaign-key> --status sent --json
mailly campaigns resend-unsent <campaign-key> --dry-run --json
mailly campaigns resend-unsent <campaign-key> --json
mailly campaigns export <campaign-key> ./campaign-results.csv
mailly campaigns history user@example.com --json
mailly campaigns complete <campaign-key> --json
```

- `pause` 后 Queue 会把尚未投递的消息持久化停放，`resume` 后由分钟级任务重新入队，支持长期暂停。
- 只有 `paused` 状态可以用 `update-content` 改主题/正文（`--subject`、`--html`/`--html-file`、`--text`/`--text-file`，`--drop-html`/`--drop-text` 删掉其中一份）。改完 `resume`，尚未投递的收件人会收到新正文（退订链接和 Footer 按收件人重新注入），已经发出去的邮件不受影响。之后再用同一 key 发送必须与新正文一致，否则返回 409。
- `cancel` 是终态，尚未投递的收件人会变成 `skipped`，不能恢复。
- `resend-unsent` 只补发 `failed` 收件人（复用同一条 recipient 记录，`attempt` +1，历史投递事件保留），有冻结受众时会一并带上从未占用成功的成员。先用 `--dry-run` 看清单；正式补发按新发送重新扣费，已 `sent` / `skipped`（退订、suppression）的收件人不会被重发。Campaign 必须处于 `sending`，暂停中请先 `resume`。
- 所有 `reserved` / `queued` / `sending` 收件人结束后才能 `complete`；发完的 Campaign 也会自动收口：Workflow 自动发送的 Campaign（`source_app = mailly_workflow`，每发一封一个 Campaign）在途清零后立即自动标记 `completed`；其它 Campaign 在收件人全部终态、没有 `failed` 且没有待派发批次时，由分钟级任务在清零满 15 分钟后自动标记 `completed`。有 `failed` 收件人的 Campaign 会保持 `sending` 以保留 `resend-unsent` 窗口，补发成功后同样自动收口，也可以随时手动 `complete`。
- 列表里的 `sending` 是 Campaign 生命周期状态，不是投递状态；收件人级最终结果看 `campaigns recipients` 与 `delivery-events`。
- `recipients` / `export` 是收件人级交付结果；批量 task 的总体处理进度仍用 `mailly status <taskId>`。
- 基础频控按此前成功发送的营销 Campaign 统计。dry-run 返回 `frequencyCappedCount` / `frequencyCappedRecipients`，被频控地址不会扣费或入队。
- `--topic-exclusion-days N` 会排除 N 天内收到相同 Topic 的联系人；dry-run 返回 `topicExcludedCount` / `topicExcludedRecipients`。
- 正式发送可加 `--schedule-at <ISO 8601 或 Unix 秒>` 定时执行；邮件用量先预留、到点入队后结算，发送前取消会退还预留。dry-run 与 test send 不要带该参数。
- `--source-app`、`--utm-file`、`--business-goal`、`--audience-definition-file` 会冻结调用方 metadata 和受众定义；正式发送和 test send 必须与同 key 的既有定义一致。

### 投递事件与签名 Webhook

需要把 Campaign 结果关联到业务用户时，发送时使用稳定 external ID：

```bash
mailly send \
  --recipient user-123=user@example.com \
  --subject "保留优惠" --from-email hello@example.com \
  --text-file body.txt --marketing --campaign-key pending-cancel-2026-07 --json
```

```bash
mailly campaigns recipients <campaign-key> --json
mailly delivery-events list --campaign-key <campaign-key> --json
mailly delivery-events list --external-id <business-user-id> --json
mailly delivery-events show <event-id> --json

mailly webhooks set --url https://example.com/mailly-webhook --json
mailly webhooks show --json
mailly webhooks disable --json
mailly delivery-events replay <event-id> --json
```

- `campaign recipient.status = sent` 只表示下游已接受；最终结果看 `delivery_status` 和 delivery event 时间线。
- 每个事件的 `messageId` 是稳定 Mailly ID；SES 等下游 ID 在 `providerMessageId`，不要混用做业务幂等键。
- Webhook 签名密钥只在首次配置或 rotate 时返回；立即保存，Agent 不要把它写进仓库或日志。
- 回调使用 `Mailly-Signature: v1=<hex>`，签名内容是 `<Mailly-Timestamp>.<raw-body>` 的 HMAC-SHA256；调用方必须以 `Mailly-Event-Id` 幂等消费。
- `delivery-events replay` 只重放调用方 Webhook，不会重发邮件；provider 重复事件本身也会按 event key 幂等。
- hard bounce 和 complaint 会自动进入 workspace suppression。Mailly 的 click 只保留原目标 URL，不应当作购买/撤销取消等最终业务转化。

### 验证码

```bash
mailly code send user@example.com --json     # 发送 6 位验证码（5 分钟有效）
mailly code verify user@example.com 123456 --json  # 校验
```

发送验证码计一封邮件用量；校验验证码不额外计费。发送失败退还预留用量。

### Template + Lifecycle Workflow

```bash
mailly templates list --json
mailly templates create --key <stable-key> --name <name> --file template.json --json
mailly templates update <stable-key> --file template.json --json
mailly templates render <stable-key> --draft --locale zh-CN --variables variables.json --json
mailly templates publish <stable-key> --json
mailly templates show <stable-key> --version 1 --json
mailly templates test-send <stable-key> --version 1 --to internal@example.com --variables variables.json --json
mailly templates archive <stable-key> --json
```

- Template 必须同时提供 HTML 和纯文本 locale 内容；variables 必须先在 schema 声明。
- Marketing Template 必须包含 `topic`、`recipientReason`，并且 Workspace 已配置真实品牌名称和有效邮寄地址。
- 发布前先 `render --draft`，发布后版本不可修改；内容更新必须产生新版本。
- `test-send` 会经过 suppression/退订并实际计入邮件用量，只能发到明确的内部测试邮箱。

```bash
mailly workflows list --json
mailly workflows show <stable-key> --json
mailly workflows create --key <stable-key> --name <name> --file workflow.json --json
mailly workflows update <stable-key> --file workflow.json --json
mailly workflows publish <stable-key> --in-flight-policy continue --json
mailly workflows pause <stable-key> --json
mailly workflows resume <stable-key> --json
mailly workflows archive <stable-key> --json
mailly workflows runs <stable-key> --json
mailly workflows run <stable-key> <run-id> --json

mailly events track --file event.json --json
mailly events batch --file events.json --json
mailly events show <event-id> --json
mailly events replay <failed-event-id> --json
mailly events timeline <external-contact-id> --json
```

- 每个业务事件必须提供稳定的 `event_id`，重试必须复用原 ID；不要为了绕过 `409` 临时生成新 ID。
- 相同 `event_id` 和相同内容是安全的幂等重试；相同 ID、不同不可变内容返回 `409`，需要修正上游事件生成逻辑。
- `send` 必须固定 `stepId` 和已发布的 `template.key + version`；不要引用草稿或省略版本。
- Variables mapping 只使用 `contact`、`trigger_event`、`latest_event`、`workflow_config`；`latest_event` 必须指定事件名，不允许任意代码。
- Workflow send 自动复用 suppression、退订 Footer、频控、Campaign 幂等、Queue 二次检查和原子计费；不要另行调用 `mailly send` 补发失败 Run。
- 使用 `mailly workflows run` 查看每个 send 的模板版本、脱敏变量摘要和最终状态，再决定是否修复事件/模板并重放。
- 发布新版本时显式使用 `--in-flight-policy continue`；`migrate` 第一阶段尚未启用。

### Contact + Audience

```bash
mailly contacts list --status active --tag vip --limit 100 --offset 0 --json
mailly contacts show <external-contact-id> --json
mailly contacts upsert <external-contact-id> --file contact.json --json
mailly contacts batch --file contacts.json --chunk-size 100 --json
mailly contacts import contacts.csv --chunk-size 100 --json
mailly contacts suppress <external-contact-id> --reason manual --json
mailly contacts delete <external-contact-id> --json
mailly contacts history <external-contact-id> --json
mailly contacts audiences <external-contact-id> --json

mailly audiences list --json
mailly audiences create --file audience.json --json
mailly audiences show <audience-key> --json
mailly audiences update <audience-key> --file audience.json --json
mailly audiences preview <audience-key> --json
mailly audiences resolve --file selection.json --json
mailly audiences members <static-audience-key> --file external-ids.json --replace --json
mailly audiences remove-member <static-audience-key> <external-contact-id> --json
mailly audiences delete <audience-key> --json
```

- `contacts list` 支持 `--status`、`--tag`、`--limit`（默认 100，最大 200，超过被服务端截断）和 `--offset`（默认 0）；响应带 `total` 和 `hasMore`，按 `offset + 已返回条数` 翻下一页，不要靠「返回条数是否等于 limit」猜。
- Contact 的 `externalId` 必须使用调用方稳定用户 ID；不要用临时随机 ID 绕过 email 唯一或 suppression。
- `contacts batch` / `contacts import` 的输入条数不限：CLI 会按 `--chunk-size`（默认 100，最大 500）顺序切分提交，返回的 `index` / `row` 已还原成原文件里的位置，`chunks` 是实际提交批次数。中途失败时会说明已完成到第几条；upsert 幂等，修正后可以直接重跑整个文件。不要自己再拆文件。
- `customFields` 只放通用字符串、数字、布尔或 ISO 时间值；Mailly 不解释 Stripe/Clerk/Search1API 字段语义。
- 动态分群必须先 `audiences preview` 核对 count、sample 和 explanation；多个 include/exclude 用 `audiences resolve` 做联合预览。
- audience 正式发送必须使用稳定 `campaignKey`。先 `--dry-run`，确认后复用相同选择移除 `--dry-run`；第一次正式发送会冻结 snapshot。
- 已冻结 Campaign 重试时可复用原 `--audience/--exclude-audience`，也可省略收件人让服务端读取 snapshot。不得换选择绕过 `409`。
- Contact 属性/标签/邮箱变化不会改变旧 snapshot，但最新 suppression、退订和频控仍会在发送和 Queue 投递前应用。
- `--test-send` 只能用明确内部 `--to`，不能使用 audience。

```bash
mailly send \
  --audience paid-api-users \
  --exclude-audience canceling-users \
  --marketing --campaign-key product-update-2026-07 \
  --subject "..." --from-email hello@example.com \
  --html-file body.html --text-file body.txt \
  --dry-run --json
```

### 发件箱（Sent Messages）

```bash
mailly outbox list --limit 50 --json
mailly outbox list --recipient user@example.com --json
mailly outbox list --recipient example.org --match fuzzy --json
mailly outbox list --sender billing@example.com --subject "Your receipt" --json
mailly outbox list --recipient user@example.com --since 2026-09-01 --until 2026-09-30 --json
mailly outbox list --source workflow --delivery-status delivered --json
mailly outbox show <mailly-message-id> --json
```

- 每位收件人、每次发送尝试对应一条 Sent Message；批量/Campaign 不再只显示一条调用日志。
- `id` 是稳定的 Mailly Message ID。Campaign 补发会产生新的 `id` 和递增的 `source.campaign.attempt`，但保留原 `campaign.messageId` 以串起业务收件人账本。
- `transport.status` 表示 Mailly/Queue 是否已处理，`delivery.status` 表示 SES 的最终投递进展；判断是否送达时以后者为准。
- 收件箱回复会同时出现在 `outbox` 和原 Inbox thread：前者负责发送/投递观察，后者保留对话上下文，不是重复发送。
- `--recipient` / `--sender` / `--subject` 默认精确匹配（忽略大小写的完整值），加 `--match fuzzy` 改为包含匹配；多个条件同时生效。只记得片段、或要跨收件人/发件人/主题/Message ID 一起找时用 `--query`（始终模糊）。都不检索正文。`--since` / `--until` 限定发送时间，用法同收件箱。
- 精确筛选优先用 `--recipient` / `--campaign-key` / `--source`。需要某封邮件的来源关联和事件时间线时使用 `show`。

### 消费日志

消费日志是按 API 调用记录的计费凭证，不是逐封邮件的发件箱。查询某位收件人的实际发送与投递结果，应使用上一节的 `outbox`。

```bash
mailly logs list --limit 20 --json       # 最新 20 条
mailly logs list --offset 100 --json     # 翻页
mailly logs export ./mailly-logs.csv     # 下载完整 CSV
```

### 自定义域名收发能力

```bash
mailly domains list --json                         # 域名归属、SES 发件和 MX 收件状态
mailly domains add mail.example.com --json         # 提交域名归属审核
mailly dns set-token --json                        # （Cloudflare 用户）校验并保存 DNS 编辑 Token
mailly domains apply-dns <domain-id> --json        # （Cloudflare 用户）一键写入发件/收件 DNS 记录
mailly domains setup-outbound <domain-id> --json   # 创建 SES 发件身份，返回要添加的 DNS 记录
mailly domains verify-outbound <domain-id> --json  # 检查 SES 是否已验证 DKIM
mailly domains verify-inbound <domain-id> --json   # 检查最高优先级 MX 是否指向 Mailly
mailly inbox addresses create --domain mail.example.com --prefix my-agent --json
```

**三个独立状态**：`ownershipStatus` 表示域名归属，`outboundStatus` 表示 SES 发件能力，`inboundStatus` 表示 MX 收件能力。归属审核通过后，发件与收件可以分别配置；仅收件不需要配置 SES。使用 `--from-email` 或从 Inbox 回复时，`outboundStatus` 必须为 `verified`。

域名归属仍由 Mailly 管理员审核，没有用户自助 approve 命令。发件和收件都是自助：发件用 `setup-outbound` 创建 SES 身份并按返回的 DNS 记录配置，再用 `verify-outbound` 检查；收件 MX 配好后用 `verify-inbound` 检查。

**Cloudflare 一键配置**：域名托管在 Cloudflare 的用户可先 `mailly dns set-token`（Token 权限 `Zone → DNS → Edit`，建议限定具体域名；支持 `--token` 参数、`CLOUDFLARE_API_TOKEN` 环境变量或管道输入），保存后对归属已验证的域名运行 `mailly domains apply-dns <domain-id>`。它会自动创建 SES 身份（如未创建）并把 DKIM CNAME、bounce MX/SPF 和收件 MX 一次性写入；幂等可重复运行，同名但内容不同的既有记录只报 `conflict` 不覆盖。写完等几分钟 DNS 生效，再运行 verify-outbound / verify-inbound。

**未保存 Cloudflare Token 或 DNS 在其他服务商时，CLI 不会代用户修改 DNS。** 归属审核通过后，Agent 必须明确告诉用户前往域名实际使用的 DNS 服务商配置，而不是只说“运行 verify-inbound / verify-outbound”。Cloudflare 的入口是对应域名的「DNS → Records → Add record」；其他 DNS 服务商使用其记录管理页面。

收件 MX：

| 字段 | 值 |
|---|---|
| Type | `MX` |
| Name / Host | 根域名通常填 `@`；子域名填对应前缀 |
| Mail server / Target | `smtp.mailly.site` |
| Priority | `10` |

发件 DNS 以 `setup-outbound` 返回的 `outboundDnsRecords` 为准（3 条 DKIM CNAME 必填；`bounce` 子域的 MX / SPF 建议添加）。CNAME 必须关闭代理。不要编造 token。

保存后再运行对应的 verify 命令。修改根域名 MX 会把整个域名的收件交给 Mailly；如果域名已有 Google Workspace、企业邮箱等服务，Agent 应建议使用独立子域名。只收件不需要配置 SES。

Agent 行为：
- **不要轮询** `mailly domains list` 等待归属审核；告诉用户「已提交，等待人工审核」就够了。
- 归属通过后，先问 DNS 是否托管在 Cloudflare：是则优先引导 `mailly dns set-token` + `mailly domains apply-dns`（一键、幂等）；否则用 `setup-outbound` 拿 DNS 记录并展示给用户，用户说已经加好记录后再跑一次 `verify-outbound`。**不要**密集轮询 verify。
- `apply-dns` 返回 `conflict` 时不要重试或建议删除既有记录；向用户说明该记录内容不同（例如根域名已有其他 MX），涉及根域名收件的建议改用子域名。
- **不要建议**用户强制 PATCH 归属或发件状态；如果归属审核未过，让他们到 mailly.site 的支持渠道催。
- 用户通过 CLI 添加域名后，必须给出 DNS 配置位置、收件 MX 四个字段、发件 `setup-outbound` / `verify-outbound`、以及根域名 MX 风险提示；不要假设用户知道 MX 在哪里配置。
- 如果用户真的需要立刻发邮件，引导他们改用已经 `outboundStatus: verified` 的域名。

### 收件箱（Inbox：收件、会话、回复、Webhook）

收件地址、会话、邮件、回复、附件与 Webhook 全部通过 CLI 操作：

```bash
# 收件地址
mailly inbox addresses list --json
mailly inbox addresses create \
  --domain mail.example.com \
  --prefix my-agent \
  --json

# 会话列表与详情（GET 无副作用；cursor 用上一页返回值）
mailly inbox threads list --limit 20 --json
mailly inbox threads list --address-id <address-id> --cursor '<cursor>' --json
mailly inbox threads show <thread-id> --json

# 按收件人 / 发件人 / 主题搜索（默认精确，--match fuzzy 为包含；--query 跨字段模糊；不检索正文）
mailly inbox threads list --recipient support@example.com --json
mailly inbox threads list --sender acme --match fuzzy --json
mailly inbox messages list --subject "Refund request" --json
mailly inbox messages list --query invoice --folder quarantine --json
mailly inbox threads list --sender acme --match fuzzy --since 2026-09-01 --until 2026-09-30 --json
mailly inbox threads list --sender-domain customer.io --since 2026-09-01 --json

# 平铺邮件列表、详情与正文
mailly inbox messages list --limit 20 --json
mailly inbox messages show <message-id> --json
mailly inbox messages content <message-id> \
  --format markdown \
  --strip-quotes \
  --json

# 只有用户真正查看后才显式标记已读；也可用 --unread
mailly inbox messages read-state <message-id> --read --json
mailly inbox threads read-state <thread-id> --read --json

# 回复；每封扣 1 积分，Agent 必须提供稳定幂等键
mailly inbox messages reply <message-id> \
  --text-file ./reply.txt \
  --html-file ./reply.html \
  --attachment ./report.pdf \
  --inline logo-1=./logo.png \
  --idempotency-key reply-ticket-123-attempt-1 \
  --json
mailly inbox replies show <request-id> --json

# 转发给别人；主题自动加 Fwd:，正文 = 备注 + 原信引用块，原附件默认一并转发（--no-attachments 关闭）
mailly inbox messages forward <message-id> \
  --to colleague@example.com \
  --text "帮忙看一下这封" \
  --idempotency-key forward-ticket-123-attempt-1 \
  --json

# 下载私有附件到本地
mailly inbox attachments download <message-id> <attachment-id> ./attachment.bin --json

# 收件 Webhook
mailly inbox webhook set \
  --url https://example.com/webhooks/mailly-received \
  --body-format markdown \
  --strip-quotes \
  --json
mailly inbox webhook get --json
mailly inbox webhook delete --json

# 单个收件地址的专属 Webhook；未配置时回落到全局 Webhook
mailly inbox webhook address get <address-id> --json
mailly inbox webhook address set <address-id> \
  --url https://example.com/webhooks/address-specific \
  --body-format markdown --strip-quotes --json
mailly inbox webhook address delete <address-id> --json
```

`--domain` 必须已经通过归属和 MX 验证；`--prefix` 可省略并由服务端随机生成。Webhook `set` 省略 `--body-format` 或去引用选项时保留现有值；用 `--no-strip-quotes` 可显式关闭。签名密钥只在首次配置或 `--rotate-secret` 时返回一次，立即保存且不要写入仓库或日志。

- **搜索**：`threads list` 与 `messages list` 支持 `--recipient`（`to_address`；入站邮件是你的收件地址，`direction: "outbound"` 的回复/转发是对方地址）、`--sender`（模糊时也匹配显示名）、`--sender-domain`（整域名精确匹配，不含子域名，走索引；按某家公司或服务商查信时优先用它，而不是 `--sender <域名片段> --match fuzzy`）、`--subject` 和 `--query`，可与 `--since` / `--until`（收件时间）、`--address-id` / `--folder` / `--cursor` 组合，所有条件同时生效。时间写 `YYYY-MM-DD` 时按本机时区的自然日，`--until` 包含当天；用户说“上周”“9 月”等相对或含糊的时间时，先换算成具体日期再查，并在回答里写明实际查询的日期范围。ISO 8601 带时区或 Unix 秒时 `--until` 是不含的精确上界。会话列表只要会话内有一封邮件同时满足全部条件就返回整条会话，`message_count` / `unread_count` / `latest_message` 仍是整条会话的值。正文暂不可搜索；按内容找邮件时先按元数据缩小范围，再用 `messages content` 读取。
- **会话（Thread）**：收到的邮件按 `In-Reply-To` / `References` 自动归入会话；通过 `mailly inbox messages reply` 发出的回复也会以 `direction: "outbound"` 出现在同一会话里。
- **转发**：`mailly inbox messages forward` 必须显式 `--to`；发出的邮件不带 In-Reply-To/References（是新线程），但记录仍以 `direction: "outbound"` 留在原会话里方便回看，发件箱里与回复同为 `inbox_reply` 来源、靠 Fwd: 主题区分。和回复一样走计费、幂等键与 `mailly inbox replies show` 查询。
- **回复规则**：收到的邮件（`direction: "inbound"`）默认回给原邮件的 `Reply-To`（字段 `reply_to_address`，Webhook 里是 `email.reply_to`），缺省才用 `From`——所以 A 发信、Reply-To 指向 C 时，回复发给 C 而不是 A；回复自己发出的邮件（`direction: "outbound"`）则沿用原收件人 `to_address`。主题自动加 `Re:`；CLI 可用 `--to` / `--subject` / `--html` 覆盖。回复走正常发送计费与配额。
- **直发自建线程**：`mailly send` 支持 `--message-id`、`--in-reply-to` 和可重复的 `--reference`。这些参数只支持单个 `--to` 的非 Campaign 直发，对方回信会自动归入原会话。
- **附件**：`mailly send` 与 `mailly inbox messages reply` 都支持可重复的 `--attachment` / `--inline`，最多 10 个、解码后总计 ≤ 6MB。仅限单收件人、无 campaign/audience 的直发；批量发送不支持附件。回复的附件会出现在会话记录里，用 `mailly inbox attachments download` 下载；下载默认不覆盖已有文件，只有用户确认后才加 `--force`。
- **内嵌图片（正文中显示）**：使用 `--inline content-id=path`，HTML 正文以 `<img src="cid:content-id">` 引用。此时必须提供 HTML；普通 `--attachment` 显示在附件区。
- **读取与已读状态**：所有 Inbox GET 都不修改 `is_read`。用户真正查看后，调用 message 或 thread 的 `read-state`；Agent/Webhook 消费者只拉 `/content`，不要替用户标记已读。
- **回复幂等与状态**：Agent 回复必须提供稳定的 `--idempotency-key`。相同 key + 相同内容返回原结果，不重复发送；相同 key + 不同内容返回 `409`。首次响应的 `request_id` 用 `mailly inbox replies show <request-id> --json` 查询。
- **删除**：`mailly inbox messages delete <id> --yes` 永久删除单封邮件；`mailly inbox addresses delete <id> --yes` 会级联删除该地址的全部邮件和附件。只有用户明确要求并确认范围后才能执行。
- **收件 Webhook**：payload 含 `type: "email.received"` 与 `email` 对象（含 `thread_id`、`reply_to`、最多 20K 字符的 `text`、`text_truncated`、`has_html`、`html_truncated`、`content_url` 和附件元数据）。正文优先用 `mailly inbox messages content` 拉取；附件用 CLI 下载。签名与投递事件 Webhook 相同：`Mailly-Signature: v1=<hex>` 是 `<Mailly-Timestamp>.<raw-body>` 的 HMAC-SHA256，密钥只在首次配置或 `--rotate-secret` 时返回一次；失败按指数退避自动重试最多 8 次，以 `Mailly-Event-Id` 幂等消费。
- Webhook 的 `text_truncated` 表示事件内最多 20K 字符的 `text` 不是完整正文，应通过 CLI 的 content 命令取全文。新邮件的完整 text/html 会被保存：D1 保留最多 512K 字符预览，超出部分存入私有 R2，`mailly inbox messages content` 会自动返回全文且 `text_truncated` / `html_truncated` 为 `false`。迁移前已被截断的历史邮件无法可靠判断时返回 `null`。
- **正文格式**：`email.body` 是 `{format, content, truncated, quotes_stripped}`，`format` 由 Webhook 配置的 `bodyFormat` 决定（`text` 默认 / `markdown` / `html`）。读取侧优先用 `mailly inbox messages content <id> --format ... --json`；Agent 消费优先选 `markdown`：转换针对邮件调校，布局表格摊平成正文而不是塞进 Markdown 表格，追踪像素与隐藏 preheader 会被丢弃，比原始 HTML 省 token 且更好读。
- **HTML 不截断**：Webhook 选择 `html` 且正文超过 200K 字符时，`body.content` 是 `null` 且 `body.truncated` 为 `true`，必须改用 `mailly inbox messages content <id> --format html --json` 取完整 HTML——截断的 HTML 会在标签中间断开，渲染结果比没有更糟。`text` / `markdown` 超过 20K 字符则正常截断并置 `truncated`。
- **`text_source`**：`plain` 表示 `text` 来自发件人的 text/plain 分段；`derived` 表示该邮件只有 HTML，纯文本是我们转换出来的。历史邮件为 `null`。
- **去引用**：对方回复时，其邮件客户端会把整条历史对话塞进这封回复的正文（实测一封真实回复 5254 字符里 5147 字符是历史）。开启 `stripQuotes` 后 `body.content` 只保留新写的内容，`body.quotes_stripped` 标明是否生效。按 `gmail_quote` / `blockquote type="cite"` / `divRplyFwdMsg` 等**结构标记**切分，不依赖归属行语言。Agent 消费建议开启，能大幅省 token。
- **去引用的安全边界**：切分是启发式的。回复写在引用下方（bottom-posting）或在引用之间穿插逐条回复时会自动放弃切分，此时 `quotes_stripped` 为 `false` 且 `content` 是完整正文——宁可漏切也不会切掉用户真正说的话。任何情况下原始邮件都不被修改，不带 `--strip-quotes` 的 CLI content 命令始终返回全文。

## 常见错误

| 错误 | 含义 | 建议处理 |
|---|---|---|
| `API error (401)` | API Key 无效或被禁用 | 让用户重新 `mailly login` |
| `API error (402): Insufficient balance` | 积分不足 | 提示用户充值，**不要重试** |
| `API error (400): Invalid "to" field` | 收件人列表格式不对 | 检查每个收件人是否含 `@` |
| `API error (400): fromEmail is required` | 缺少发件人 | 用 `mailly domains list` 选一个 |
| `API error (502)` | 上游邮件服务异常 | 隔几秒后重试一次；仍然失败请用户稍后再试 |
| `No API key found` | 本地无凭据 | 让用户先 `mailly login` |

## Agent 行为指南

1. **读优先**：先 `mailly balance --json` / `mailly domains list --json` 拿状态，再决定能否发送。
2. **JSON 调用**：所有非交互场景都加 `--json`，用 `jq` 或在程序里解析。
3. **批量任务必报告 taskId**：发送完成后把 `taskId` 告诉用户，并提示用 `mailly status <taskId>` 查询。
4. **不要硬编码内容**：邮件正文、收件人都应来自用户输入或工作产物，不要替用户编主题/正文。
5. **大批量分批**：超过 1000 个收件人时，提议拆成多批，避免单次任务超时。
   同一 campaign 的所有分批必须复用同一个 `--campaign-key`。
6. **不要回写 API Key**：CLI 输出的 API Key 已脱敏；不要把完整 Key 写进对话或日志。
7. **测试发送**：Campaign 用正式 key 加 `--test-send` 发给内部审核邮箱，不要另造临时 campaign key。

## 示例任务

> 用户：「帮我用 Mailly 给 newsletter@example.com 发一封欢迎邮件，标题是『欢迎加入』」

正确流程：
1. `mailly balance --json` 确认余额 ≥ 1。
2. `mailly domains list --json` 拿到一个 `outboundStatus: verified` 的域名。
3. 询问用户邮件正文 / 发件人显示名（或使用对话已有内容）。
4. `mailly send --to newsletter@example.com --subject "欢迎加入" --from-email noreply@<verified-domain> --html "<p>...</p>" --json`
5. 把响应里的 `success` / `provider_response` 反馈给用户。

> 用户：「我准备搞个产品发布通知，给这个 CSV 里的 5000 个用户群发一下。」

正确流程：
1. 余额检查（≥ 5000 积分）。
2. 域名检查。
3. 用脚本将 CSV 解析为收件人数组，分批 1000 人调用一次 `mailly send`。
4. 每次记录 `taskId`，最后一次性轮询所有 `mailly status` 报告进度。
