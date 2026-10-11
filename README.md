# mailly-cli

English | [简体中文](README.zh-CN.md)

The command-line interface for [Mailly](https://mailly.site): two-way inboxes, sending, templates, campaigns, workflows, and agent drafts from your terminal or your AI agent. It wraps the [Mailly HTTP API](https://api.mailly.site/docs).

## Install

Requires Node.js 18+.

```bash
npm install -g mailly-cli
mailly --help
```

## Quick start

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

The full command reference is in [README.zh-CN.md](README.zh-CN.md).

## JSON output for scripts and agents

Every command accepts `--json`. Success exits with `0`; failure exits with `1` and prints `{"success":false,"error":"..."}`.

```bash
mailly balance --json
```

## Agent Skill

[`skills/mailly/SKILL.md`](skills/mailly/SKILL.md) teaches Claude Code and other agents when and how to use the `mailly` CLI, including the checks to run before sending.

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
