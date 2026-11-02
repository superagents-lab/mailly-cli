import { promises as fs } from 'node:fs';
import type { Command } from 'commander';
import type {
  InboxWebhookDeliveryInput,
  InboxWebhookDeliverySettings,
  InboxWebhookFilters,
  MaillyClient,
} from '../client.js';
import { getOutputFormat, info, printJSON, printTable, success } from '../output.js';

const DELIVERY_STATUSES = ['pending', 'delivering', 'retrying', 'delivered', 'failed'];

function collect(value: string, previous: string[]) {
  return [...previous, value];
}

function parseInteger(min: number, max: number) {
  return (value: string) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`must be a whole number from ${min} to ${max}`);
    return parsed;
  };
}

export interface DeliveryOptions {
  header: string[];
  keepHeader: string[];
  clearHeaders?: boolean;
  payload?: string;
  template?: string;
  templateFile?: string;
  bodyMaxChars?: number;
  filterTo?: string[];
  fromInclude: string[];
  fromExclude: string[];
  subjectInclude: string[];
  subjectExclude: string[];
  skipAutomated?: boolean;
  clearFilters?: boolean;
  maxPerMinute?: string;
  batchWindow?: number;
  maxAttempts?: number;
}

/** Adds the delivery-setting options. `toFilter` only for the default webhook: an address endpoint only gets its own address. */
export function addDeliveryOptions(command: Command, { toFilter }: { toFilter: boolean }) {
  command
    .option('--header <name=value>', 'Custom request header, e.g. "Authorization=Bearer xxx" (repeatable; replaces all stored headers; values are stored encrypted)', collect, [] as string[])
    .option('--keep-header <name>', 'Keep a stored header without retyping its value when replacing headers (repeatable)', collect, [] as string[])
    .option('--clear-headers', 'Remove all custom headers')
    .option('--payload <mode>', 'raw (full email.received event) or template (your JSON template)')
    .option('--template <json>', 'JSON body template with {{from}} {{to}} {{subject}} {{body_markdown}} {{thread_id}} {{message_id}} ... (values are JSON-escaped; quote text variables)')
    .option('--template-file <path>', 'Read the JSON body template from a file')
    .option('--body-max-chars <n>', 'Cut longer bodies to this many characters (100-20000, default 20000)', parseInteger(100, 20000));
  if (toFilter) command.option('--filter-to <address>', 'Only mail sent to this address (repeatable)', collect, [] as string[]);
  return command
    .option('--from-include <address-or-domain>', 'Only senders matching this (repeatable)', collect, [] as string[])
    .option('--from-exclude <address-or-domain>', 'Skip senders matching this (repeatable)', collect, [] as string[])
    .option('--subject-include <keyword>', 'Only subjects containing this keyword (repeatable)', collect, [] as string[])
    .option('--subject-exclude <keyword>', 'Skip subjects containing this keyword (repeatable)', collect, [] as string[])
    .option('--skip-automated', 'Skip auto-replies, bulk/list mail and bounces')
    .option('--no-skip-automated', 'Send automated mail too')
    .option('--clear-filters', 'Remove all filters')
    .option('--max-per-minute <n|off>', 'At most this many requests per minute (1-600); extra mail waits. "off" removes the limit')
    .option('--batch-window <seconds>', 'Merge mail arriving within this many seconds into one request (10-3600; 0 sends each email on its own)', parseInteger(0, 3600))
    .option('--max-attempts <n>', 'Attempts before a delivery is marked failed (1-8, default 8)', parseInteger(1, 8));
}

/** Turns command options into API fields; options not given are left out so stored values stay. */
export async function deliveryInputFrom(opts: DeliveryOptions): Promise<InboxWebhookDeliveryInput> {
  const input: InboxWebhookDeliveryInput = {};

  if (opts.clearHeaders) {
    if (opts.header.length || opts.keepHeader.length) throw new Error('Use either --clear-headers or --header/--keep-header');
    input.headers = [];
  } else if (opts.header.length || opts.keepHeader.length) {
    input.headers = [
      ...opts.keepHeader.map((name) => ({ name: name.trim() })),
      ...opts.header.map((entry) => {
        const at = entry.indexOf('=');
        if (at <= 0) throw new Error(`--header must look like name=value: ${entry}`);
        return { name: entry.slice(0, at).trim(), value: entry.slice(at + 1).trim() };
      }),
    ];
  }

  if (opts.template !== undefined && opts.templateFile) throw new Error('Use either --template or --template-file');
  const template = opts.templateFile ? await fs.readFile(opts.templateFile, 'utf8') : opts.template;
  if (template !== undefined) input.template = template;
  if (opts.payload !== undefined) {
    if (opts.payload !== 'raw' && opts.payload !== 'template') throw new Error('--payload must be raw or template');
    input.payloadMode = opts.payload;
  } else if (template !== undefined) {
    input.payloadMode = 'template';
  }
  if (opts.bodyMaxChars !== undefined) input.bodyMaxChars = opts.bodyMaxChars;

  const filters: InboxWebhookFilters = {};
  if (opts.filterTo?.length) filters.toAddresses = opts.filterTo;
  if (opts.fromInclude.length) filters.fromInclude = opts.fromInclude;
  if (opts.fromExclude.length) filters.fromExclude = opts.fromExclude;
  if (opts.subjectInclude.length) filters.subjectInclude = opts.subjectInclude;
  if (opts.subjectExclude.length) filters.subjectExclude = opts.subjectExclude;
  if (typeof opts.skipAutomated === 'boolean') filters.skipAutomated = opts.skipAutomated;
  if (opts.clearFilters) {
    if (Object.keys(filters).length) throw new Error('Use either --clear-filters or filter options');
    input.filters = null;
  } else if (Object.keys(filters).length) {
    input.filters = filters;
  }

  if (opts.maxPerMinute !== undefined) {
    input.maxPerMinute = opts.maxPerMinute === 'off' ? null : parseInteger(1, 600)(opts.maxPerMinute);
  }
  if (opts.batchWindow !== undefined) {
    if (opts.batchWindow > 0 && opts.batchWindow < 10) throw new Error('--batch-window must be 0 or 10-3600 seconds');
    input.batchWindowSeconds = opts.batchWindow;
  }
  if (opts.maxAttempts !== undefined) input.maxAttempts = opts.maxAttempts;
  return input;
}

export function printDeliverySettings(settings: InboxWebhookDeliverySettings) {
  const headers = settings.headers ?? [];
  info(`Headers: ${headers.length ? headers.map((header) => `${header.name}: ${header.valueHint}`).join(', ') : 'none'}`);
  info(`Payload: ${settings.payloadMode === 'template' ? 'JSON template' : 'raw event'}`);
  if (settings.payloadMode === 'template' && settings.template) info(`Template: ${settings.template}`);
  if (settings.bodyMaxChars) info(`Body limit: ${settings.bodyMaxChars} characters`);
  const filters = settings.filters ?? {};
  const parts = [
    filters.toAddresses?.length ? `to ${filters.toAddresses.join(', ')}` : '',
    filters.fromInclude?.length ? `from ${filters.fromInclude.join(', ')}` : '',
    filters.fromExclude?.length ? `not from ${filters.fromExclude.join(', ')}` : '',
    filters.subjectInclude?.length ? `subject has ${filters.subjectInclude.join(' / ')}` : '',
    filters.subjectExclude?.length ? `subject lacks ${filters.subjectExclude.join(' / ')}` : '',
    filters.skipAutomated ? 'skip automated mail' : '',
  ].filter(Boolean);
  info(`Filters: ${parts.length ? parts.join('; ') : 'none'}`);
  info(`Rate limit: ${settings.maxPerMinute ? `${settings.maxPerMinute} per minute` : 'none'}`);
  info(`Batching: ${settings.batchWindowSeconds ? `merge mail within ${settings.batchWindowSeconds}s` : 'off'}`);
  if (settings.maxAttempts) info(`Max attempts: ${settings.maxAttempts}`);
}

export function registerDeliveryLog(webhook: Command, clientFor: (command: Command) => Promise<MaillyClient>) {
  webhook
    .command('deliveries')
    .alias('log')
    .description('List inbound webhook deliveries, newest first (mail skipped by filters is not listed)')
    .option('--endpoint-id <id>', 'Endpoint ID (whk_...) or "default" for the default webhook')
    .option('--status <status>', `Only this status: ${DELIVERY_STATUSES.join(' / ')}`)
    .option('--failed', 'Shortcut for --status failed')
    .option('--email-id <id>', 'Only deliveries of this email')
    .option('--limit <n>', 'Rows per page (1-100)', parseInteger(1, 100))
    .option('--cursor <cursor>', 'nextCursor from the previous page')
    .action(async (
      opts: { endpointId?: string; status?: string; failed?: boolean; emailId?: string; limit?: number; cursor?: string },
      command: Command,
    ) => {
      const status = opts.failed ? 'failed' : opts.status;
      if (status && !DELIVERY_STATUSES.includes(status)) throw new Error(`--status must be one of ${DELIVERY_STATUSES.join(' / ')}`);
      const res = await (await clientFor(command)).listInboxWebhookDeliveries({ ...opts, status });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.deliveries.length) return info('No deliveries');
      printTable(
        ['ID', 'Status', 'Tries', 'HTTP', 'Subject', 'Endpoint', 'Created'],
        res.deliveries.map((delivery) => [
          delivery.id,
          delivery.status,
          String(delivery.attemptCount),
          delivery.responseStatus == null ? '-' : String(delivery.responseStatus),
          (delivery.subject ?? '').slice(0, 40),
          delivery.endpointId,
          delivery.createdAt,
        ]),
      );
      for (const delivery of res.deliveries.filter((row) => row.status === 'failed' && row.error)) {
        info(`${delivery.id}: ${delivery.error}`);
      }
      if (res.nextCursor) info(`More: --cursor ${res.nextCursor}`);
    });

  webhook
    .command('redeliver')
    .alias('resend')
    .description('Send one delivery again with the endpoint\'s current URL and settings (the receiver may run its work again)')
    .argument('<delivery-id>', 'Delivery ID from mailly inbox webhook deliveries')
    .action(async (deliveryId: string, _opts: unknown, command: Command) => {
      const res = await (await clientFor(command)).redeliverInboxWebhook(deliveryId);
      if (getOutputFormat() === 'json') return printJSON(res);
      const delivery = res.delivery;
      if (delivery.status === 'delivered') success(`Delivered (HTTP ${delivery.responseStatus})`);
      else {
        process.exitCode = 1;
        info(`Status: ${delivery.status}${delivery.responseStatus ? ` (HTTP ${delivery.responseStatus})` : ''}`);
        if (delivery.error) info(`Error: ${delivery.error}`);
      }
      if (delivery.responseBody) info(`Response: ${delivery.responseBody}`);
    });
}
