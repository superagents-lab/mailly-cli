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
  const outbox = program.command('outbox').description('查询每位收件人的已发邮件与投递状态');

  addMailSearchOptions(outbox
    .command('list', { isDefault: true })
    .description('列出或搜索已发邮件（每位收件人、每次尝试一条）')
    .option('--source <kind>', '按来源过滤：api/web/campaign/workflow/template_test/inbox_reply')
    .option('--status <status>', '按发送状态过滤')
    .option('--delivery-status <status>', '按投递状态过滤')
    .option('--campaign-key <key>', '按 Campaign key 过滤')
    .option('--task-id <id>', '按批量任务 ID 过滤')
    .option('--provider-message-id <id>', '按 Provider Message ID 过滤'), {
    sender: '按发件人搜索（匹配方式见 --match）',
    query: '跨收件人、发件人、主题和 Message ID 模糊搜索（不含正文）',
    time: '发送时间',
  })
    .option('--limit <n>', '返回条数（默认 50，最大 200）', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
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
      if (!res.messages?.length) return info('暂无已发邮件');
      printTable(
        ['时间', '来源', '收件人', '主题', '状态', 'Message ID'],
        res.messages.map((message: any) => [
          fmtTimestamp(message.createdAt),
          truncate(sourceContext(message), 28),
          truncate(message.recipient?.email, 30),
          truncate(message.subject, 34),
          message.delivery?.status ?? message.transport?.status ?? '-',
          truncate(message.id, 28),
        ]),
      );
      info(c.dim(`显示 ${res.messages.length} / ${res.total} 封 (offset=${res.offset}, limit=${res.limit})`));
    });

  outbox
    .command('show')
    .description('查看一封已发邮件及其投递上下文')
    .argument('<message-id>', 'Mailly Message ID')
    .action(async (messageId, _opts, command) => {
      const res = await (await clientFor(command)).getSentMessage(messageId);
      if (getOutputFormat() === 'json') return printJSON(res);
      const message = res.message;
      info(`${message.subject || '(无主题)'} (${message.id})`);
      info(`  From: ${message.from?.name ? `${message.from.name} <${message.from.email}>` : message.from?.email}`);
      info(`  To: ${message.recipient?.email}`);
      info(`  Source: ${sourceContext(message)}`);
      info(`  Transport: ${message.transport?.status}${message.transport?.reason ? ` (${message.transport.reason})` : ''}`);
      info(`  Delivery: ${message.delivery?.status ?? '-'}`);
      info(`  Provider Message ID: ${message.transport?.providerMessageId ?? '-'}`);
      info(`  Events: ${res.events?.length ?? 0}`);
    });
}
