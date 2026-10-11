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
  const events = program.command('delivery-events').description('Query per-recipient delivery events and replay webhooks');

  events
    .command('list', { isDefault: true })
    .option('--campaign-key <key>', 'Filter by campaign key')
    .option('--recipient-id <id>', 'Filter by Mailly recipient ID')
    .option('--external-id <id>', 'Filter by your contact external_id')
    .option('--message-id <id>', 'Filter by Mailly message ID')
    .option('--provider-message-id <id>', 'Filter by provider message ID')
    .option('--type <type>', 'Filter by standard event type')
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listDeliveryEvents(opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.events?.length) return info('No delivery events');
      printTable(['Event ID', 'Type', 'External ID', 'Email', 'Campaign', 'Time', 'Webhook'], res.events.map((event: any) => [
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
      info(`  Recipient: ${res.event.contactExternalId ?? '-'} <${res.event.recipientEmail}>`);
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
      success(`Webhook for delivery event ${eventId} queued for replay`);
    });
}
