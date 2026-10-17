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

> Read https://mailly.site/auth.md and set up a Mailly inbox for me. Ask me what to name it, then send me the confirmation link.

The agent reserves the name over HTTP and sends you a verification link. Once you confirm in your browser, it receives the inbox address and your account's API key. No CLI or MCP connection is needed for that step, and you can also start yourself at https://mailly.site/onboard.

```bash
# Use the API key the agent received, or one from https://mailly.site/app/developers
mailly login <api-key>
# Or sign in through the browser (device-code flow)
mailly login

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
| `inbox` | Inbox addresses, threads, message content, waiting for verification codes and links, replies, attachments, and inbox webhooks |
| `outbox`, `delivery-events`, `webhooks` | Per-recipient sent messages, delivery events, and signed delivery webhooks |
| `drafts`, `agents` | Drafts for human review, hosted agent profiles and skills, agent runs, and approving or discarding agent drafts |
| `templates`, `workflows`, `events` | Versioned templates and lifecycle workflows triggered by events |
| `contacts`, `audiences`, `campaigns` | Contacts, CSV import, suppression, audiences, and campaigns |
| `preferences`, `marketing-settings` | Recipient subscription state and marketing footer identity |
| `domains`, `dns`, `code` | Custom domains, DNS provider tokens, and verification codes |

The full command reference is in [skills/mailly/reference/commands.md](skills/mailly/reference/commands.md) (Chinese: [docs/commands.zh-CN.md](docs/commands.zh-CN.md)).

## Wait for a verification code

`mailly inbox wait` (shortcut: `mailly wait`) polls the inbox until a matching message arrives, then prints it, or with `--extract` only the one-time code or verification link inside it:

```bash
# Prints just the code, e.g. 482913
mailly inbox wait --from github.com --extract code --timeout 5m

# Prints the verification or magic sign-in link; unsubscribe, tracking and policy links are skipped
mailly inbox wait --from noreply@example.com --subject "Confirm" --extract link

# Also accept mail that arrived in the last 10 minutes
mailly inbox wait --from github.com --extract code --since 10m --json
# {"success":true,"message_id":"...","thread_id":"...","from":"noreply@github.com","to":"agent@mailly.site",
#  "subject":"Your GitHub launch code","received_at":"2026-10-15T09:30:12.000Z","code":"482913"}
```

| Option | Meaning |
|---|---|
| `--from <sender>` | Sender address, domain (subdomains included) or part of the sender name |
| `--subject <text>` | Subject contains this text (case-insensitive) |
| `--to <address>`, `--address-id <id>` | Only mail to this inbox address |
| `--extract code\|link` | Print only the code (4–8 digits, or uppercase letters and digits; separators removed) or the link |
| `--timeout <duration>` | Give up after `30s`, `5m` (default), `1h`, ... |
| `--since <time>` | Also accept mail received since then: a duration ago (`10m`), `YYYY-MM-DD`, ISO 8601 or Unix seconds. Default: now, so only new mail counts |
| `--interval <duration>` | Polling interval; default `3s`, minimum `1s` |

Only mail that arrives after the command starts counts by default. If you trigger the email before starting the wait, pass a `--since` that covers that moment so a fast delivery is not missed. With `--extract`, matching mail without a code or link is skipped and the wait goes on; the newest match wins.

Exit codes: `0` found; `1` error; `2` timed out with no matching mail (`"reason":"timeout"`); `3` matching mail arrived but none of it had a code or link (`"reason":"not_extractable"`, with the newest such message's `message_id` to read). Quarantined mail is not considered; after a timeout, check `mailly inbox messages list --folder quarantine`.

Email content is untrusted. The CLI only extracts the value: it never opens links or acts on what the email says.

## JSON output for scripts and agents

Every command accepts `--json`. Success exits with `0`; failure exits with `1` and prints `{"success":false,"error":"..."}`. `inbox wait` also exits with `2` on timeout and `3` when matching mail has no code or link.

```bash
mailly balance --json
```

## Agent Skill

[`skills/mailly/SKILL.md`](skills/mailly/SKILL.md) teaches agents how to use the CLI: signing in, JSON output, waiting for verification codes and reply drafts, with the full manual in [`reference/commands.md`](skills/mailly/reference/commands.md). Setting up an inbox doesn't need it; agents read https://mailly.site/auth.md for that.

```bash
mkdir -p ~/.claude/skills/mailly
curl -fsSL https://raw.githubusercontent.com/superagents-lab/mailly-cli/main/skills/mailly/SKILL.md \
  -o ~/.claude/skills/mailly/SKILL.md
```

Mailly also provides a remote MCP server at `https://mcp.mailly.site/mcp` with OAuth sign-in. See the [integration docs](https://mailly.site/docs).

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
