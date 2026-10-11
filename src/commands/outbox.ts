import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON, printTable } from '../output.js';
import { addMailSearchOptions, mailSearchQuery } from '../search.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

function fmtTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function truncate(value: string | null | undefined, max: number): string {
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function sourceContext(message: any): string {
  const source = message.source ?? {};
  if (source.workflow) return `workflow:${source.workflow.key ?? source.workflow.runId}`;
  if (source.campaign) return `campaign:${source.campaign.key}${source.campaign.attempt > 1 ? `#${source.campaign.attempt}` : ''}`;
  if (source.template) return `template:${source.template.key}${source.template.version ? `@${source.template.version}` : '@draft'}`;
  if (source.inbox) return `inbox:${source.inbox.threadId}`;
  return source.app ?? source.kind ?? 'api';
}

export function registerOutbox(program: Command) {
  const outbox = program.command('outbox').description('Query sent email and delivery status per recipient');

  addMailSearchOptions(outbox
    .command('list', { isDefault: true })
    .description('List or search sent email (one row per recipient per attempt)')
    .option('--source <kind>', 'Filter by source: api/web/campaign/workflow/template_test/inbox_reply')
    .option('--status <status>', 'Filter by send status')
    .option('--delivery-status <status>', 'Filter by delivery status')
    .option('--campaign-key <key>', 'Filter by campaign key')
    .option('--task-id <id>', 'Filter by batch task ID')
    .option('--provider-message-id <id>', 'Filter by provider message ID'), {
    sender: 'Search by sender (see --match for matching)',
    query: 'Fuzzy search across recipient, sender, subject, and message ID (not the body)',
    time: 'Send time',
  })
    .option('--limit <n>', 'Number of results (default 50, max 200)', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listSentMessages({
        source: opts.source,
        status: opts.status,
        deliveryStatus: opts.deliveryStatus,
        campaignKey: opts.campaignKey,
        taskId: opts.taskId,
        providerMessageId: opts.providerMessageId,
        ...mailSearchQuery(opts),
        limit: opts.limit,
        offset: opts.offset,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.messages?.length) return info('No sent email');
      printTable(
        ['Time', 'Source', 'Recipient', 'Subject', 'Status', 'Message ID'],
        res.messages.map((message: any) => [
          fmtTimestamp(message.createdAt),
          truncate(sourceContext(message), 28),
          truncate(message.recipient?.email, 30),
          truncate(message.subject, 34),
          message.delivery?.status ?? message.transport?.status ?? '-',
          truncate(message.id, 28),
        ]),
      );
      info(c.dim(`Showing ${res.messages.length} / ${res.total} (offset=${res.offset}, limit=${res.limit})`));
    });

  outbox
    .command('show')
    .description('Show one sent email and its delivery context')
    .argument('<message-id>', 'Mailly Message ID')
    .action(async (messageId, _opts, command) => {
      const res = await (await clientFor(command)).getSentMessage(messageId);
      if (getOutputFormat() === 'json') return printJSON(res);
      const message = res.message;
      info(`${message.subject || '(no subject)'} (${message.id})`);
      info(`  From: ${message.from?.name ? `${message.from.name} <${message.from.email}>` : message.from?.email}`);
      info(`  To: ${message.recipient?.email}`);
      info(`  Source: ${sourceContext(message)}`);
      info(`  Transport: ${message.transport?.status}${message.transport?.reason ? ` (${message.transport.reason})` : ''}`);
      info(`  Delivery: ${message.delivery?.status ?? '-'}`);
      info(`  Provider Message ID: ${message.transport?.providerMessageId ?? '-'}`);
      info(`  Events: ${res.events?.length ?? 0}`);
    });
}
