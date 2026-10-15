# mailly-cli

[English](../README.md) | 简体中文

[Mailly](https://mailly.site) 官方命令行工具，封装 [Mailly API](https://api.mailly.site/docs) 的用户端能力：收发邮件、验证码、查询余额、管理域名与收件箱。配套的 Agent Skill 在 [`skills/mailly/SKILL.md`](../skills/mailly/SKILL.md)。

## 安装

需要 Node.js 18+：

```bash
npm install -g mailly-cli
mailly --help
```

## 快速开始

```bash
# 1. 登录 — 默认会开浏览器到 mailly.site，你在浏览器里点「授权」即可
mailly login
# CI / 远程环境直接粘贴 API Key
mailly login sk_live_xxxxxxxxxxxx

# 2. 看看自己是谁
mailly whoami

# 3. 查看域名归属、SES 发件与 MX 收件状态
mailly domains list

# 4. 发一封邮件（HTML + 纯文本 multipart，反垃圾邮件分数更好）
mailly send \
  --to friend@example.com \
  --subject "Hello from Mailly" \
  --from-email your-inbox@mailly.site \
  --from-name "Mailly" \
  --html "<p>It works!</p>" \
  --text "It works!"
```

正文支持三种形态：
- 仅 HTML：`--html` 或 `--html-file`
- 仅纯文本：`--text` 或 `--text-file`
- 同时给两份：自动按 `multipart/alternative` 发送，客户端按能力挑一个显示

单收件人直发还支持本地附件和邮件线程头：

```bash
mailly send \
  --to user@example.com \
  --subject "Re: Hello" \
  --from-email agent@example.com \
  --html '<p>Logo <img src="cid:logo-1"></p>' \
  --text "附件见邮件" \
  --attachment report.pdf \
  --inline logo-1=logo.png \
  --in-reply-to '<original-message-id@example.com>' \
  --reference '<root-message-id@example.com>'
```

附件最多 10 个、解码后合计不超过 6MB；普通附件（`--attachment`）不支持多收件人、`--recipient`、Campaign 或 Audience。`--inline` 必须同时提供 HTML，带 `--campaign-key` 时可用于 Campaign 群发：图片按 Campaign 存一份，只接受 `image/*`、最多 10 张、合计 1MB，且每个 content-id 必须在 HTML 里被 `cid:` 引用；同一 campaign key 的图片集合冻结，换图返回 409。

## 凭据来源（优先级）

1. `--api-key <key>` 命令行参数（最高优先）
2. `MAILLY_API_KEY` 环境变量
3. `~/.mailly/config.json`（`mailly login` 写入，权限 0600）

`MAILLY_BASE_URL` / `--base-url` 同样支持，默认 `https://api.mailly.site`。

## 命令参考

```
mailly login [--no-browser] [--web-url URL]           # 浏览器授权（device code flow）
mailly login --resume <device-token>                  # 续办 login --json 发起的授权
mailly login <api-key> [--no-verify]                  # 直接粘贴 API Key（CI 友好）
mailly login [...] [--base-url URL]
mailly logout
mailly whoami
mailly balance

mailly send [--to <email>...|--recipient <external-id=email>...] --subject <s> --from-email <e> [--from-name <n>] \
            [--html <h>|--html-file <p>] [--text <t>|--text-file <p>] \
            [--cc <e>] [--bcc <e>] [--provider <p>] \
            [--email-type transactional|lifecycle|marketing] [--marketing] \
            [--campaign-key <key>] [--campaign-name <name>] [--topic <topic>] \
            [--audience <key>...] [--exclude-audience <key>...] \
            [--test-send] [--frequency-cap-days <days> --frequency-cap-max <count>] \
            [--topic-exclusion-days <days>] [--reply-to <email>] \
            [--source-app <app>] [--utm-file <json>] [--business-goal <goal>] \
            [--audience-definition-file <json>] [--schedule-at <iso-or-unix>] \
            [--attachment <path>...] [--inline <content-id=path>...] \
            [--message-id <id>] [--in-reply-to <id>] [--reference <id>...] \
            [--var <name=value>...] [--variables <json>] \
            [--from-template <key> [--template-version N|--template-draft] [--locale <locale>]] \
            [--dry-run]
```

`--var` / `--variables` 会替换 subject、HTML 和纯文本里的 `{{name}}`；正文出现的每个 token 都必须有值，HTML 里的值自动转义。`--from-template <key>` 直接用已发布模板渲染正文（主题、发件人、邮件类型、Topic、频控都取自模板，显式参数优先），并自动记录 templateKey/templateVersion。

```bash
mailly status <taskId>

mailly campaigns list [--limit N] [--offset N]
mailly campaigns create --file campaign.json
mailly campaigns show <campaign-key>
mailly campaigns audience <campaign-key>
mailly campaigns pause|resume|cancel|complete <campaign-key>
mailly campaigns update-content <campaign-key> [--subject S] [--html-file F] [--text-file F]
mailly campaigns recipients <campaign-key> [--status <status>]
mailly campaigns resend-unsent <campaign-key> [--dry-run]
mailly campaigns export <campaign-key> [output.csv]
mailly campaigns history <email> [--limit N] [--offset N]

mailly delivery-events list [--campaign-key <key>] [--external-id <id>] [--type <type>]
mailly delivery-events show <event-id>
mailly delivery-events replay <event-id>

# 统一发件箱（每位收件人、每次发送尝试一条）
mailly outbox list [--recipient <email>] [--sender <email>] [--subject <text>] [--match exact|fuzzy] [--query <text>] \
  [--since <time>] [--until <time>] \
  [--source <kind>] [--delivery-status <status>] [--limit N] [--offset N]
mailly outbox show <mailly-message-id>

mailly webhooks show
mailly webhooks set --url <https-url> [--events delivered,hard_bounced,...] [--rotate-secret]
mailly webhooks disable

mailly marketing-settings show
mailly marketing-settings set --brand-name <name> --postal-address <address>

mailly preferences show <email>
mailly preferences resubscribe <email> --scope workspace --source <source> \
  --consent-at <ISO-8601> --consent-reference <reference>

mailly workflows list
mailly workflows create --key <key> --name <name> --file workflow.json
mailly workflows show <key>
mailly workflows update <key> --file workflow.json [--name <name>]
mailly workflows publish <key> [--in-flight-policy continue]
mailly workflows pause|resume|archive <key>
mailly workflows runs <key> [--status <status>]
mailly workflows run <key> <run-id>
mailly workflows cancel <key> <run-id> --reason <text>

mailly templates list
mailly templates create --key <key> --name <name> --file template.json
mailly templates show <key> [--version N]
mailly templates update <key> --file template.json [--name <name>]
mailly templates publish <key>
mailly templates render <key> [--version N|--draft] [--locale <locale>] [--variables variables.json]
mailly templates test-send <key> --to <email> [--version N|--draft] [--variables variables.json]
mailly templates archive <key>

mailly events track --file event.json
mailly events batch --file events.json
mailly events show <event-id>
mailly events replay <event-id>
mailly events timeline <external-contact-id> [--limit N]

mailly contacts list [--status <status>] [--tag <tag>] [--limit N] [--offset N]   # 响应含 total / hasMore
mailly contacts show <external-contact-id>
mailly contacts upsert <external-contact-id> --file contact.json
mailly contacts batch --file contacts.json [--chunk-size N]
mailly contacts import contacts.csv [--chunk-size N]
mailly contacts suppress|delete <external-contact-id>
mailly contacts history|audiences <external-contact-id>

mailly audiences list
mailly audiences create --file audience.json
mailly audiences show|preview <audience-key>
mailly audiences update <audience-key> --file audience.json
mailly audiences resolve --file selection.json
mailly audiences members <audience-key> --file external-ids.json [--replace]
mailly audiences remove-member <audience-key> <external-contact-id>

mailly code send <email>
mailly code verify <email> <code>

mailly logs list [--limit N] [--offset N]
mailly logs export [output.csv]

mailly domains list
mailly domains add <domain>
mailly domains setup-outbound <domain-id>
mailly domains verify-outbound <domain-id>
mailly domains verify-inbound <domain-id>

mailly inbox addresses list
mailly inbox addresses create --domain <domain> [--prefix <prefix>]
mailly inbox addresses delete <address-id> --yes
mailly inbox threads list [--address-id <id>] [--sender-domain <domain>] [--recipient <email>] [--sender <email>] [--subject <text>] [--match exact|fuzzy] [--query <text>] \
  [--since <time>] [--until <time>] \
  [--limit N] [--cursor <cursor>]
mailly inbox threads show <thread-id>
mailly inbox threads read-state <thread-id> --read|--unread
mailly inbox messages list [--address-id <id>] [--sender-domain <domain>] [--recipient <email>] [--sender <email>] [--subject <text>] [--match exact|fuzzy] [--query <text>] \
  [--since <time>] [--until <time>] \
  [--limit N] [--cursor <cursor>]
mailly inbox messages show <message-id>
mailly inbox messages content <message-id> [--format text|markdown|html] [--strip-quotes]
mailly inbox messages read-state <message-id> --read|--unread
mailly inbox messages reply <message-id> --idempotency-key <key> \
  [--text <text>|--text-file <path>] [--html <html>|--html-file <path>] \
  [--to <email>] [--subject <subject>] [--from-name <name>] \
  [--attachment <path>...] [--inline <content-id=path>...]
mailly inbox messages delete <message-id> --yes
mailly inbox replies show <request-id>
mailly inbox attachments download <message-id> <attachment-id> [output] [--force]
mailly inbox webhook get
mailly inbox webhook set --url <https-url> [--body-format text|markdown|html] \
                         [--strip-quotes|--no-strip-quotes] \
                         [--signing-secret <secret>|--rotate-secret]
mailly inbox webhook delete
mailly inbox webhook test
mailly inbox webhook endpoints list [--address-id <address-id>]
mailly inbox webhook endpoints get <endpoint-id>
mailly inbox webhook endpoints add --address-id <address-id> --url <https-url> \
  [--body-format text|markdown|html] [--strip-quotes] \
  [--signing-secret <secret>] [--disable]
mailly inbox webhook endpoints update <endpoint-id> [--url <https-url>] \
  [--body-format text|markdown|html] [--strip-quotes|--no-strip-quotes] \
  [--enable|--disable] [--signing-secret <secret>|--rotate-secret]
mailly inbox webhook endpoints test <endpoint-id>
mailly inbox webhook endpoints delete <endpoint-id>
mailly inbox webhook address get <address-id>     # 旧接口：只作用于该地址最早的端点
mailly inbox webhook address set <address-id> --url <https-url> \
  [--body-format text|markdown|html] [--strip-quotes|--no-strip-quotes] \
  [--signing-secret <secret>|--rotate-secret]
mailly inbox webhook address delete <address-id>

mailly --json <command>     # 全局：以 JSON 输出
```

完整用法见 `mailly <command> --help`。

自定义域名先完成归属审核，之后发件与收件独立配置。`mailly domains setup-outbound <domain-id>` 会在 SES 创建发件身份并返回 DKIM / MAIL FROM DNS 记录；把记录加到 DNS 后运行 `mailly domains verify-outbound <domain-id>`。`verify-inbound` 只检查最高优先级 MX 是否指向 `smtp.mailly.site`，不要求该域名已在 SES 配置；但使用该域名发送或从 Inbox 回复仍要求 SES 发件状态为 `verified`。

归属审核通过后，必须前往域名实际使用的 DNS 服务商添加 MX，这一步不在 Mailly 完成。Cloudflare 用户进入对应域名的「DNS → Records → Add record」：

| 字段 | 值 |
|---|---|
| Type | `MX` |
| Name / Host | 根域名通常填 `@`；子域名填对应前缀 |
| Mail server / Target | `smtp.mailly.site` |
| Priority | `10` |

保存后运行 `mailly domains verify-inbound <domain-id> --json`。修改根域名 MX 会把整个域名的收件交给 Mailly；如果已有 Google Workspace、企业邮箱等服务，请改用独立子域名。只收件不需要配置 SES。

发件 DNS 以 `setup-outbound` 返回的 `outboundDnsRecords` 为准：3 条 DKIM CNAME 必填，且必须关闭 Cloudflare 代理；`bounce` 子域的 MX / SPF 建议添加，用于自定义 MAIL FROM。加好后运行 `mailly domains verify-outbound <domain-id> --json`。

MX 验证通过后，可以直接创建仅收件地址：

```bash
mailly inbox addresses create \
  --domain inbound.example.com \
  --prefix tickets \
  --json
```

省略 `--prefix` 时由服务端随机生成前缀。域名归属或 MX 尚未验证时，服务端会拒绝创建。

列出地址、会话和邮件：

```bash
mailly inbox addresses list --json
mailly inbox threads list --limit 20 --json
mailly inbox threads show <thread-id> --json
mailly inbox messages list --address-id <address-id> --limit 20 --json
mailly inbox messages show <message-id> --json
```

按收件人、发件人或主题搜索（收件箱 threads/messages 与 `outbox list` 参数相同，暂不检索正文）：

```bash
mailly inbox threads list --recipient support@example.com --json
mailly inbox threads list --sender acme --match fuzzy --json
mailly inbox messages list --subject "Refund request" --json
mailly inbox messages list --query invoice --json
mailly outbox list --recipient example.org --match fuzzy --json
mailly inbox threads list --sender acme --match fuzzy --since 2026-09-01 --until 2026-09-30 --json
mailly inbox threads list --sender-domain customer.io --since 2026-09-01 --json
mailly outbox list --recipient user@example.com --since 2026-09-24T00:00:00Z --json
```

`--recipient` / `--sender` / `--subject` 默认 `--match exact`：忽略大小写的完整匹配；`--match fuzzy` 改为包含匹配，收件箱发件人模糊匹配时也会匹配显示名。多个条件同时生效（AND）。`--query` 始终跨字段模糊搜索。收件箱另有 `--sender-domain`：忽略大小写的整域名匹配（`customer.io` 不含 `mail.customer.io`），走索引，按公司/服务商找邮件时比 `--sender <片段> --match fuzzy` 更快更准。`--since` / `--until` 限定收件时间（发件箱为发送时间）：只写 `YYYY-MM-DD` 时按本机时区的自然日，`--since` 从当天零点起、`--until` 包含当天；ISO 8601 按其自带时区、纯数字按 Unix 秒，此时 `--until` 是不含的精确上界。直接调 API 时 `since`（含）/ `until`（不含）接受 Unix 秒或 ISO 8601，只写日期按 UTC 零点。会话列表中有一封邮件同时满足全部条件即返回整条会话，计数与最新摘要不受筛选影响。

列表使用 cursor 分页：把响应中的 `cursor` 原样传给下一次 `--cursor`。上述 GET 命令均不会修改已读状态；需要用户明确查看后再执行：

```bash
mailly inbox messages read-state <message-id> --read --json
mailly inbox threads read-state <thread-id> --unread --json
```

无副作用地按所需格式读取正文：

```bash
mailly inbox messages content <message-id> \
  --format markdown \
  --strip-quotes \
  --json
```

`--format` 默认是 `text`，也可选 `markdown` 或 `html`。`--strip-quotes` 会尝试去掉发件人客户端附带的引用历史；响应中的 `content.quotes_stripped` 表明本次是否可靠识别并去除了引用。读取不会修改邮件的已读状态。

从原收件地址回复，并用稳定幂等键避免重试时重复发送：

```bash
mailly inbox messages reply <message-id> \
  --text-file reply.txt \
  --html-file reply.html \
  --attachment report.pdf \
  --inline logo-1=logo.png \
  --idempotency-key reply-ticket-123-attempt-1 \
  --json
mailly inbox replies show <request-id> --json
```

回复收到的邮件默认发给原邮件的 `Reply-To`（字段 `reply_to_address`，没有则用 `From`）；回复自己发出的邮件（`direction` 为 `outbound`）则沿用原收件人 `to_address`。主题自动添加 `Re:`。`--to`、`--subject` 和 `--from-name` 可覆盖默认值。附件最多 10 个、解码后总计不超过 6MB；`--inline content-id=path` 需要 HTML 中存在对应的 `cid:content-id` 引用。

下载收件附件：

```bash
mailly inbox attachments download <message-id> <attachment-id> ./downloaded-file --json
```

下载默认不覆盖已存在的文件；只有确认要替换时才加 `--force`。

配置新邮件到达时的签名 Webhook：

```bash
mailly inbox webhook set \
  --url https://example.com/webhooks/mailly-received \
  --body-format markdown \
  --strip-quotes \
  --json
mailly inbox webhook get --json
mailly inbox webhook delete --json
mailly inbox webhook test --json
```

`set` 省略 `--body-format` 或去引用选项时会保留现有值；用 `--no-strip-quotes` 可显式关闭。签名密钥只在首次配置或 `--rotate-secret` 时返回一次，应立即保存。`delete` 只停用配置并保留投递历史。

也可为单个收件地址配置专属端点，每个地址最多 10 个。地址有启用的专属端点时，来信会推给它的每个启用端点（各自签名、各自重试），不再推默认 Webhook；没有启用端点时回落到默认 Webhook：

```bash
mailly inbox webhook endpoints add --address-id <address-id> \
  --url https://example.com/webhooks/address-specific \
  --body-format markdown --strip-quotes --json
mailly inbox webhook endpoints list --address-id <address-id> --json
mailly inbox webhook endpoints update <endpoint-id> --disable --json
mailly inbox webhook endpoints test <endpoint-id> --json
mailly inbox webhook endpoints delete <endpoint-id> --json
```

`webhook test` 和 `endpoints test` 会立即发送一条签名的 `webhook.test` 事件（请求头 `Mailly-Event-Type: webhook.test`，body 带 `test: true`），返回接收端的 HTTP 状态和耗时并记录为 `lastTest`；不入队、不重试，停用的端点也能测。接收端未返回 2xx 时命令退出码为 1；同一端点 5 秒内只能测一次。旧的 `webhook address get|set|delete <address-id>` 仍可用，但只操作该地址最早创建的端点。

永久删除需要显式确认：`messages delete <id> --yes` 删除单封邮件；`addresses delete <id> --yes` 会级联删除该地址的全部邮件、正文和附件。

营销发送必须提供稳定的 `--campaign-key`。同一 workspace 中，同一 campaign key + 同一邮箱只会产生一次业务发送；重复执行会在 dry-run 的 `alreadySentRecipients` 中返回，不会再次入队。`--marketing` 是 `--email-type marketing` 的快捷形式。

先用 `--test-send` 给内部邮箱验证最终邮件；测试发送照常检查退订/suppression 并扣积分，但不占用正式收件人幂等记录，也不受 Campaign 频控。正式发送时复用同一 `--campaign-key`、主题、发件人和正文，移除 `--test-send`。要设置「7 天最多 2 封营销邮件」，同时传 `--frequency-cap-days 7 --frequency-cap-max 2`；dry-run 会额外返回 `frequencyCappedCount` 和 `frequencyCappedRecipients`。

正式 Campaign（包括只有一个收件人）都会进入 Queue。用 `--schedule-at 2026-08-01T01:00:00Z` 定时发送；积分会先预留、到点入队后结算，发送前取消会退还预留。用 `--topic-exclusion-days 14` 排除 14 天内收到同 Topic 的联系人。`mailly campaigns pause/resume/cancel` 控制投递，暂停消息会持久化等待恢复，暂停期间可用 `campaigns update-content` 改主题/正文，恢复后未投递的收件人自动收到新版本；`mailly campaigns resend-unsent <key>` 一键补发投递失败的收件人（先 `--dry-run` 看清单，按新发送扣费）；用 `recipients` 查看收件人级状态、`history <email>` 查看联系人跨 Campaign 历史、`export` 交付 CSV。发完的 Campaign 会自动收口：Workflow 自动发送的 Campaign（`source_app = mailly_workflow`）在途收件人清零后立即标记 `completed`；其它 Campaign 在收件人全部终态、没有 `failed` 且没有待派发定时批次时，由分钟级任务在清零满 15 分钟后标记 `completed`，有 `failed` 的保持 `sending` 以保留 `resend-unsent` 窗口。需要提前收口时显式执行 `mailly campaigns complete <key>`。

需要把邮件结果关联到业务用户时，用 `--recipient <external-id=email>` 代替 `--to`，例如 `--recipient user-123=user@example.com`。`campaigns recipients` 会同时显示 Queue 发送状态与 provider 投递结果；`delivery-events` 可按 external ID 补拉完整时间线。Webhook 签名密钥只在首次创建或 rotate 时返回，签名是 `<timestamp>.<raw-body>` 的 HMAC-SHA256；消费者应以 `Mailly-Event-Id` 幂等处理，`delivery-events replay` 只重放 Webhook，不会重复发送邮件。

## Contact 与 Audience

联系人可通过单条、批量 JSON 或 CSV 同步。CSV 至少包含 `external_id,email`，可选 `name,locale,status,tags,custom_fields`；`tags` 可用 JSON 数组或分号列表，`custom_fields` 是 JSON 对象。

动态分群例子：

```json
{
  "key": "paid-api-users",
  "name": "已付费 API 用户",
  "type": "dynamic",
  "filter": {
    "operator": "all",
    "conditions": [
      { "field": "customFields.paid", "operator": "eq", "value": true },
      { "field": "customFields.product", "operator": "eq", "value": "api" }
    ]
  }
}
```

```bash
mailly audiences create --file paid-api-users.json --json
mailly audiences preview paid-api-users --json
mailly send \
  --audience paid-api-users \
  --exclude-audience canceling-users \
  --marketing --campaign-key api-update-2026-07 \
  --subject "..." --from-email hello@example.com \
  --html-file body.html --text-file body.txt \
  --dry-run --json
```

正式移除 `--dry-run` 时会冻结受众 snapshot。以后 Contact 属性、标签、状态或邮箱变化不会改变该 Campaign 的收件人；最新 suppression/退订仍会在发送前和 Queue 投递前应用。重试可以复用相同 audience 选择，也可以省略 `--to/--audience` 让服务端读取既有 snapshot。测试发送必须继续使用明确的内部 `--to`。

首次使用 `--marketing` 前，先配置一次 Workspace 品牌信息：

```bash
mailly marketing-settings set \
  --brand-name "Search1API" \
  --postal-address "123 Market Street, San Francisco, CA 94105"
```

Mailly 会自动生成与正文分隔的 HTML/纯文本 Footer，包含收信原因、品牌、邮寄地址和 `Unsubscribe from non-essential emails` 退订入口。该 Workspace 级退订会停止产品更新、使用引导、促销等非必要邮件；账号、账单、安全和购买回执等必要服务邮件仍会发送。可在发送时增加 `--recipient-reason "You are receiving this because ..."`；调用方不能删除或替换退订链接。

## 查询与恢复订阅

查询收件人的 Workspace preference、active suppression 和最近重新同意记录：

```bash
mailly preferences show recipient@example.com --json
```

只有取得明确重新同意后才能恢复：

```bash
mailly preferences resubscribe recipient@example.com \
  --scope workspace \
  --source support_ticket \
  --consent-at 2026-07-16T03:15:00Z \
  --consent-reference ticket-1234 \
  --json
```

重试必须复用同一 `--consent-reference` 和完全相同的同意证据。该命令原子解除 `unsubscribed` suppression、恢复 preference 并写不可变审计；不要改用两个底层 API 手工协调。`hard_bounce`、`complaint` 和 `manual` 会被普通恢复拒绝。

## Template + Lifecycle Workflow

正式邮件内容维护在 Mailly Template 中。Template 发布后版本不可修改；Workflow 只引用明确的 `template.key + version`，因此模板新版本不会静默改变已发布 Workflow 或在途 Run。

模板示例 `activation-template.json`：

```json
{
  "defaultLocale": "en",
  "emailType": "lifecycle",
  "from": { "email": "lifecycle@mailly.site", "name": "Search1API" },
  "topic": "api_onboarding",
  "variables": {
    "name": { "type": "string", "required": true },
    "docs_url": { "type": "string", "required": true }
  },
  "locales": {
    "en": {
      "subject": "Make your first Search1API request",
      "html": "<p>Hello {{name}}</p><p><a href=\"{{docs_url}}\">Open the guide</a></p>",
      "text": "Hello {{name}}. Open the guide: {{docs_url}}"
    },
    "zh": {
      "subject": "完成第一次 Search1API 请求",
      "html": "<p>你好，{{name}}</p><p><a href=\"{{docs_url}}\">查看指南</a></p>",
      "text": "你好，{{name}}。查看指南：{{docs_url}}"
    }
  }
}
```

```bash
mailly templates create --key activation --name "首次请求激活" --file activation-template.json
mailly templates render activation --draft --locale zh-CN --variables variables.json --json
mailly templates publish activation --json
mailly templates test-send activation --version 1 --to internal@example.com --variables variables.json --json
```

Marketing Template 还必须包含 `recipientReason`，并先配置 Workspace Marketing Footer。发布时会检查发件域名、HTML/纯文本、变量声明和 Marketing 配置。

Workflow 定义支持事件触发、联系人/事件条件、延迟、目标事件退出和 `send`。`send` 会复用 suppression、退订、Campaign 幂等、频控、Queue 二次检查和原子计费。

示例 `trial-onboarding.json`：

```json
{
  "trigger": { "event": "trial.started" },
  "entryCondition": {
    "source": "contact",
    "path": "plan",
    "operator": "eq",
    "value": "trial"
  },
  "steps": [
    { "type": "delay", "duration": "1d" },
    {
      "type": "condition",
      "if": {
        "source": "event",
        "path": "source",
        "operator": "eq",
        "value": "api"
      },
      "onFalse": "exit"
    },
    {
      "type": "send",
      "stepId": "activation-email",
      "template": { "key": "activation", "version": 1 },
      "variables": {
        "name": { "source": "contact", "path": "name" },
        "docs_url": { "source": "workflow_config", "path": "docs_url" }
      }
    }
  ],
  "config": { "docs_url": "https://example.com/docs" },
  "exitOn": ["api.first_request_succeeded"],
  "reentry": "after_exit"
}
```

```bash
mailly workflows create \
  --key trial-onboarding \
  --name "Search1API Trial Onboarding" \
  --file trial-onboarding.json
mailly workflows publish trial-onboarding
```

业务侧上报的每个事件都必须有稳定且全局唯一的 `event_id`，重试时复用原 ID：

```json
{
  "event_id": "evt_trial_started_user_123_20260715",
  "event_name": "trial.started",
  "occurred_at": "2026-07-15T10:00:00.000Z",
  "contact": {
    "external_contact_id": "user_123",
    "email": "user@example.com",
    "attributes": { "plan": "trial", "locale": "zh-CN" }
  },
  "properties": { "source": "api" }
}
```

```bash
mailly events track --file trial-started.json --json
mailly events timeline user_123 --json
mailly workflows runs trial-onboarding --json
mailly workflows run trial-onboarding <run-id> --json
```

需要停掉某一条在途 Run（`queued`/`running`/`waiting`）时，用 `mailly workflows cancel <key> <run-id> --reason <text>`。Run 会变成 `terminated`，`exit_reason` 为 `cancelled`，不再执行后续 delay、条件或发送；已经发出的邮件不会撤回，同一 Workflow 的其他 Run 不受影响。对已结束的 Run 重复取消不会改动任何记录。取消原因和时间记录在 `mailly workflows run <key> <run-id>` 的日志里。

Variables mapping 支持 `contact`、`trigger_event`、`latest_event`（必须指定 `event`）和 `workflow_config`。Contact 的 `locale` 会按 exact → language → Template default 回退。`--file -` 可从 stdin 读取 JSON。重复上报相同 `event_id` 和相同不可变内容会返回成功且不会重复触发；同 ID 但内容不同会返回 `409`。

Contact 以 `external_id` 为业务身份：新事件和 `contacts upsert` 可以更新邮箱及 custom fields，send 始终读取当前邮箱或已冻结 Campaign snapshot 中的邮箱；同一 Workspace 内两个 Contact 不能占用同一邮箱。`contacts delete` 是保留历史归因的软删除，并自动加入 Workspace suppression；恢复前必须先显式解除 suppression，再以 `status: "active"` upsert，不能靠换 Contact ID 绕过退订。

## 让 AI Agent 自动调用 mailly（Claude Code Skill）

仓库提供了 [`skills/mailly/SKILL.md`](../skills/mailly/SKILL.md)，里面写好了：

- 何时触发（用户提到发邮件 / 验证码 / 余额 / 域名 / Mailly 时）；
- 完整命令速查、参数和注意事项；
- 错误码与重试策略；
- Agent 行为约定（必须 `--json`、批量必报告 taskId、不要自己编 API Key 等）。

**安装方法**（Skill 与 CLI 解耦，需要手动放置一次）：

```bash
mkdir -p ~/.claude/skills/mailly
curl -fsSL https://raw.githubusercontent.com/superagents-lab/mailly-cli/main/skills/mailly/SKILL.md \
  -o ~/.claude/skills/mailly/SKILL.md
```

放好之后，下次启动 Claude Code 就会按描述自动加载。然后只要说「用 Mailly 给 xxx 发一封欢迎邮件」，Agent 会按 Skill 里的流程跑：

1. `mailly balance --json` 检查余额；
2. `mailly domains list --json` 选已验证的发件域名；
3. `mailly send … --json` 发送，并把 `taskId` / 状态反馈给用户。

## 退出码与 JSON 模式

- 成功：退出码 `0`
- 失败：退出码 `1`，错误信息写入 `stderr`

加 `--json` 让所有命令改为输出 JSON：

```bash
mailly balance --json
# {"success":true,"balance":1234}

mailly send ... --json
# {"success":true,"message":"...","provider_response":{...}}

mailly send ... --json   # 失败时
# {"success":false,"error":"..."}
```

适合在脚本和 Agent 中解析。

## 开发

```bash
npm install
npm test
node bin/mailly.mjs --help
```

源码结构：

```
├── bin/mailly.mjs          # 入口（node shebang）
├── src/
│   ├── index.ts            # commander 注册
│   ├── client.ts           # Mailly API 客户端
│   ├── config.ts           # ~/.mailly/config.json 读写
│   ├── output.ts           # 着色 / 表格 / JSON 输出
│   └── commands/*.ts       # 各子命令
└── skills/mailly/SKILL.md  # Agent Skill
```

## License

MIT

## Agent 档案与用户 Skills

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

### Agent 评估记录与草稿审批

托管 Agent 每处理一封来信生成一条 run，包含评估结论；`draft` 模式下还会起草回复，等人审批。

```bash
mailly agents runs list --approval-status pending --json
mailly agents runs list --agent-id <agent-id> --thread-id <thread-id> --limit 20 --json
mailly agents runs show <run-id> --json
mailly agents runs approve <run-id> --text-file ./reply.txt --yes --json
mailly agents runs approve <run-id> --text-file - --yes --json < ./reply.txt
mailly agents runs discard <run-id> --json
```

- `list` 支持 `--agent-id / --thread-id / --email-id / --status / --approval-status / --limit`（1–200，默认 100）；`--approval-status pending` 找出待审批的草稿。
- `approve` 把 `--text-file` 中的文本作为回复发出，必须是人类已核对过的最终全文，并带上 `--yes`。先用 `show` 读出 `draft_text` 给人类看，确认收件人和正文后再发送；同一 run 重复批准不会再发第二封。run 仍在处理中或已不在待审批状态时返回 409。
- `discard` 放弃草稿，不发送。
