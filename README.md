# mailly-cli

English | [简体中文](docs/commands.zh-CN.md)

The command-line interface for [Mailly](https://mailly.site): two-way inboxes, sending, templates, campaigns, workflows, and agent drafts from your terminal or your AI agent. It wraps the [Mailly HTTP API](https://api.mailly.site/docs).

## Install

Requires Node.js 18+.

```bash
npm install -g mailly-cli
mailly --help
```

## Quick start

No account yet? Give your agent this prompt:

> Read https://mailly.site/skill.md and reserve my chosen Mailly inbox name using HTTP; ask me for the name if unknown. If taken, ask me for another name; no blind retries. Give me only the verification link. After I sign in/register with my verified external email and explicitly bind this chosen inbox on the web page, report the address and completion, then STOP. Do not obtain credentials, read mail, send mail or authorize account access.

No agent, CLI, Node.js or MCP connection is required: you can start directly at https://mailly.site/onboard using the same API. Public `POST https://api.mailly.site/onboarding/start` without authentication, with `Content-Type: application/json` and JSON `{"name":"chosen-name"}`, returns `address` (string `chosen-name@mailly.site`), `request_id`, `verification_url`, `status_url`, temporary `setup_token`, `expires_in: 1800` and `interval: 5`. Choose your preferred name; agents must ask if unknown. Names are trimmed/lowercased, 1–64 characters from `a-z0-9._-`, start/end alphanumeric; reserved system names are rejected. The name is reserved for 30 minutes against existing inboxes and pending reservations. HTTP 409 `code=name_taken`: ask for another name, never blindly mass-retry. Expiration or cancellation releases it. Starting creates no user or receiving inbox; anonymous receiving and reading are deferred. The agent keeps the token private and gives you only the verification URL. Sign in/register with your verified external email (not mailly.site or a subdomain), opening the magic link yourself, then explicitly bind this chosen inbox—not agent account access.

The agent polls `GET status_url` with `Authorization: Bearer <setup_token>` at least 5 seconds apart: pending is HTTP 202, denied is HTTP 200, ready is HTTP 200 `{success:true,status:"ready",address:{id,address},hint}`. Setup expires in 30 minutes; ready status remains retrievable for 10 minutes after human confirmation. It returns no `api_key` or other mailbox credentials. The token only polls this setup: it cannot read mail, send or access the account. Denial, expiration or rate limiting stops setup without automatic restart. Only confirmation binds the chosen inbox within account quotas. Never substitute an existing account inbox or an auto-generated name; there is no multi-inbox selection. The agent reports the address and completion, then stops. This public HTTP exception adds no CLI command or MCP tool.

Receive and read mail in the authenticated web console; only that human console provides API Key information at `/app/developers`. Independently decide whether to connect API/MCP/CLI later. Agents must not scrape the console, collect keys in chat, automate verification/confirmation, read your external inbox to redeem the magic link, or auto-authorize MCP/CLI as a fallback. Never put passwords, codes, tokens or keys in agent chat or committed files.

中文：先选名称，Agent 不知道时必须询问；HTTP 预留 30 分钟，冲突请人类另选，不盲目重试。可直接在 https://mailly.site/onboard 开始，无需 Agent、CLI 或 MCP。人类用已验证外部邮箱登录或注册，再按额度明确绑定这个邮箱，不替换为已有邮箱或自动名称，也不提供多邮箱选择。预留不创建用户或收件邮箱，过期或取消释放名称，匿名收件和读信暂缓；不授予 Agent 账户访问。开通只返回地址与提示，不返回 API Key 或其他凭据；Agent 报告完成后停止。用户可在已登录工作台收件、读信，在 `/app/developers` 查看 API Key，自行决定后续接入。

### Optional, separately authorized CLI workflows

The commands below are a reference, not an automatic continuation of setup.

```bash
# Sign in through the browser (device-code flow)
mailly login
# CI or remote machines: paste an API key instead
mailly login <api-key>

mailly whoami
mailly balance

# List your inboxes and read what arrives
mailly inbox addresses list
mailly inbox threads list

# Send an email
mailly send \
  --to friend@example.com \
  --subject "Hello from Mailly" \
  --from-email your-inbox@mailly.site \
  --html "<p>It works!</p>" \
  --text "It works!"
```

Run `mailly <command> --help` for every option.

## Credentials

In order of precedence:

1. `--api-key <key>`
2. `MAILLY_API_KEY` environment variable
3. `~/.mailly/config.json`, written by `mailly login` with mode 0600

`--base-url` / `MAILLY_BASE_URL` default to `https://api.mailly.site`.

## Commands

| Command | What it does |
|---|---|
| `login`, `logout`, `whoami` | Sign in with the browser or an API key, and check the current account |
| `balance`, `logs` | Usage balance and consumption logs |
| `send`, `status` | Send email; multi-recipient sends and campaigns are queued and return a task ID |
| `inbox` | Inbox addresses, threads, message content, replies, attachments, and inbox webhooks |
| `outbox`, `delivery-events`, `webhooks` | Per-recipient sent messages, delivery events, and signed delivery webhooks |
| `drafts`, `agents` | Drafts for human review, and hosted agent profiles and skills |
| `templates`, `workflows`, `events` | Versioned templates and lifecycle workflows triggered by events |
| `contacts`, `audiences`, `campaigns` | Contacts, CSV import, suppression, audiences, and campaigns |
| `preferences`, `marketing-settings` | Recipient subscription state and marketing footer identity |
| `domains`, `dns`, `code` | Custom domains, DNS provider tokens, and verification codes |

The full command reference (Chinese) is in [docs/commands.zh-CN.md](docs/commands.zh-CN.md).

## JSON output for scripts and agents

Every command accepts `--json`. Success exits with `0`; failure exits with `1` and prints `{"success":false,"error":"..."}`.

```bash
mailly balance --json
```

## Agent Skill

[`skills/mailly/SKILL.md`](skills/mailly/SKILL.md) teaches HTTP-first setup without credentials and stops after reporting the address. No CLI or MCP prerequisites. The optional, separately authorized CLI manual remains in [`reference/commands.md`](skills/mailly/reference/commands.md).

```bash
mkdir -p ~/.claude/skills/mailly
curl -fsSL https://raw.githubusercontent.com/superagents-lab/mailly-cli/main/skills/mailly/SKILL.md \
  -o ~/.claude/skills/mailly/SKILL.md
```

Mailly also provides a remote MCP server at `https://api.mailly.site/mcp` with OAuth sign-in. See the [integration docs](https://mailly.site/docs).

## Development

```bash
npm install
npm test
node bin/mailly.mjs --help
```

## Support

Report CLI issues on [GitHub](https://github.com/superagents-lab/mailly-cli/issues). For account or billing questions, email sys@mailly.site.

## License

MIT
