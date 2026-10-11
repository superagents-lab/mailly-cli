import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, printTable, success } from '../output.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

export function registerDeliveryEvents(program: Command) {
  const events = program.command('delivery-events').description('查询收件人级投递事件并重放 Webhook');

  events
    .command('list', { isDefault: true })
    .option('--campaign-key <key>', '按 Campaign key 过滤')
    .option('--recipient-id <id>', '按 Mailly recipient ID 过滤')
    .option('--external-id <id>', '按业务 contact external_id 过滤')
    .option('--message-id <id>', '按 Mailly Message ID 过滤')
    .option('--provider-message-id <id>', '按 provider Message ID 过滤')
    .option('--type <type>', '按标准事件类型过滤')
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listDeliveryEvents(opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.events?.length) return info('暂无投递事件');
      printTable(['事件 ID', '类型', 'External ID', '邮箱', 'Campaign', '时间', 'Webhook'], res.events.map((event: any) => [
        event.id,
        event.type,
        event.contactExternalId ?? '',
        event.recipientEmail,
        event.campaignKey,
        event.timestamp,
        event.webhook?.status ?? '-',
      ]));
    });

  events
    .command('show')
    .argument('<event-id>')
    .action(async (eventId, _opts, command) => {
      const res = await (await clientFor(command)).getDeliveryEvent(eventId);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${res.event.type} (${res.event.id})`);
      info(`  收件人: ${res.event.contactExternalId ?? '-'} <${res.event.recipientEmail}>`);
      info(`  Campaign: ${res.event.campaignKey}`);
      info(`  Message ID: ${res.event.messageId ?? '-'}`);
      info(`  Provider Message ID: ${res.event.providerMessageId ?? '-'}`);
      info(`  Webhook: ${res.webhook?.status ?? 'not_configured'}`);
    });

  events
    .command('replay')
    .argument('<event-id>')
    .action(async (eventId, _opts, command) => {
      const res = await (await clientFor(command)).replayDeliveryWebhook(eventId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`投递事件 ${eventId} 的 Webhook 已进入重放队列`);
    });
}
