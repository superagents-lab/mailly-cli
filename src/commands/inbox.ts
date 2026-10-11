import { promises as fs } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient, type InboxBodyFormat, type InboxListOptions, type InboxMessage } from '../client.js';
import { addMailSearchOptions } from '../search.js';
import { getOutputFormat, info, printJSON, printTable, success, warn } from '../output.js';
import { loadEmailAttachments } from '../attachments.js';

const INBOX_BODY_FORMATS = ['text', 'markdown', 'html'] as const;

function parseInboxBodyFormat(value: string): InboxBodyFormat {
  if (INBOX_BODY_FORMATS.includes(value as InboxBodyFormat)) return value as InboxBodyFormat;
  throw new Error(`Body format must be one of ${INBOX_BODY_FORMATS.join(' / ')}`);
}

function parseInboxFolder(value: string): string {
  if (value === 'inbox' || value === 'quarantine') return value;
  throw new Error('folder must be inbox or quarantine');
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('must be a positive integer');
  return parsed;
}

const INBOX_SEARCH_LABELS = {
  sender: 'Search by sender; with --match fuzzy it also matches the display name',
  query: 'Fuzzy search across recipient, sender, display name, and subject (not the body)',
  time: 'Received time',
};

function formatTimestamp(value?: number | null): string {
  return value ? new Date(value * 1000).toISOString() : '-';
}

function truncate(value: string | null | undefined, max = 48): string {
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function printMessage(message: InboxMessage) {
  info(`ID: ${message.id}`);
  info(`Thread: ${message.thread_id}`);
  info(`Direction: ${message.direction}`);
  info(`From: ${message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address}`);
  // Replies go to Reply-To rather than From by default; show it only when they differ so the reply target is clear.
  if (message.reply_to_address && message.reply_to_address !== message.from_address) {
    info(`Reply-To: ${message.reply_to_address}`);
  }
  info(`To: ${message.to_address}`);
  info(`Subject: ${message.subject || '(no subject)'}`);
  info(`Time: ${formatTimestamp(message.received_at)}`);
  info(`Read: ${message.is_read ? 'yes' : 'no'}`);
  if (message.folder) info(`Folder: ${message.folder}`);
  if (message.quarantine_reason) info(`Quarantine reason: ${message.quarantine_reason}`);
  if (message.authentication_json) info(`Authentication: ${message.authentication_json}`);
  if (message.text_body) info(`\n${message.text_body}`);
  else if (message.html_body) info(`\n${message.html_body}`);
}

async function readOptionalFile(inline: string | undefined, path: string | undefined, label: string) {
  if (inline && path) throw new Error(`${label} cannot be combined with its file option`);
  return path ? fs.readFile(path, 'utf8') : inline;
}

function readStateFromOptions(opts: { read?: boolean; unread?: boolean }): boolean {
  if (Boolean(opts.read) === Boolean(opts.unread)) {
    throw new Error('Specify exactly one of --read or --unread');
  }
  return Boolean(opts.read);
}

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

export function registerInbox(program: Command) {
  const inbox = program.command('inbox').description('Manage inbox addresses, messages, and the inbound webhook');
  const addresses = inbox.command('addresses').description('Manage inbox addresses');

  addresses
    .command('list', { isDefault: true })
    .description('List inbox addresses and available domains for this account')
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).listInboxAddresses();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.addresses.length) return info('No inbox addresses');
      printTable(['ID', 'Address', 'Messages', 'Created at'], res.addresses.map((address) => [
        address.id,
        address.address,
        String(address.message_count),
        formatTimestamp(address.created_at),
      ]));
    });

  addresses
    .command('create')
    .description('Create an address on a domain with MX inbound enabled')
    .requiredOption('--domain <domain>', 'Domain that has passed ownership and MX verification')
    .option('--prefix <prefix>', 'Address prefix; the server generates a random one if omitted')
    .action(async (opts: { domain: string; prefix?: string }, command) => {
      const res = await (await clientFor(command)).createInboxAddress({
        domain: opts.domain.trim().toLowerCase(),
        ...(opts.prefix?.trim() ? { prefix: opts.prefix.trim().toLowerCase() } : {}),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.address) throw new Error(res.error || 'Failed to create inbox address');
      success(`Inbox address ${res.address.address} created`);
    });

  addresses
    .command('delete')
    .description('Delete an inbox address with all its messages and attachments')
    .argument('<address-id>', 'Inbox address ID')
    .requiredOption('--yes', 'Confirm permanently deleting the address with all its messages and attachments')
    .action(async (addressId: string, _opts: { yes: boolean }, command: Command) => {
      const res = await (await clientFor(command)).deleteInboxAddress(addressId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Inbox address ${addressId} and its messages deleted`);
    });

  const messages = inbox.command('messages').description('Read inbound messages');

  addMailSearchOptions(messages
    .command('list', { isDefault: true })
    .description('List or search message summaries page by page; reading does not change read state')
    .option('--address-id <id>', 'Only show this inbox address')
    .option('--limit <n>', 'Number of results', parsePositiveInteger)
    .option('--cursor <cursor>', 'Next-page cursor returned by the server')
    .option('--folder <folder>', 'inbox / quarantine (default inbox)', parseInboxFolder)
    .option('--sender-domain <domain>', 'Filter by sender domain (case-insensitive exact domain match, subdomains excluded; indexed)'), INBOX_SEARCH_LABELS)
    .action(async (opts: InboxListOptions, command) => {
      const res = await (await clientFor(command)).listInboxMessages(opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.messages.length) return info('No messages');
      printTable(['Time', 'Status', 'Direction', 'From', 'To', 'Subject', 'ID'], res.messages.map((message) => [
        formatTimestamp(message.received_at),
        message.direction === 'outbound' ? '-' : (message.is_read ? 'read' : 'unread'),
        message.direction,
        truncate(message.from_address, 30),
        truncate(message.to_address, 30),
        truncate(message.subject),
        message.id,
      ]));
      if (res.cursor) info(`Next page cursor: ${res.cursor}`);
    });

  messages
    .command('show')
    .description('Show one message; reading does not change read state')
    .argument('<message-id>', 'Message ID')
    .action(async (messageId: string, _opts, command) => {
      const res = await (await clientFor(command)).getInboxMessage(messageId);
      if (getOutputFormat() === 'json') return printJSON(res);
      printMessage(res.message);
    });

  messages
    .command('release')
    .description('Restore a quarantined message to the inbox; does not replay webhooks or trigger agents')
    .argument('<message-id>', 'Message ID')
    .requiredOption('--yes', 'Confirm you reviewed the message and want it restored to the inbox')
    .action(async (messageId: string, _opts, command) => {
      const res = await (await clientFor(command)).releaseInboxMessage(messageId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Message ${messageId} restored to the inbox`);
    });

  messages
    .command('content')
    .description('Read the body of one message without side effects')
    .argument('<message-id>', 'Message ID')
    .option(
      '--format <format>',
      'Body format: text / markdown / html (default text)',
      parseInboxBodyFormat,
      'text',
    )
    .option('--strip-quotes', 'Strip quoted reply history added by mail clients')
    .action(async (
      messageId: string,
      opts: { format: InboxBodyFormat; stripQuotes?: boolean },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).getInboxMessageContent(messageId, {
        format: opts.format,
        stripQuotes: opts.stripQuotes,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      const content = res.content[opts.format];
      if (content == null) return info(`This message has no ${opts.format} body`);
      info(content);
      if (opts.stripQuotes && res.content.quotes_stripped === false) {
        warn('Could not reliably detect quoted history; returning the full body');
      }
    });

  messages
    .command('read-state')
    .description('Set the read state of one inbound message')
    .argument('<message-id>', 'Message ID')
    .option('--read', 'Mark as read')
    .option('--unread', 'Mark as unread')
    .action(async (
      messageId: string,
      opts: { read?: boolean; unread?: boolean },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).setInboxMessageReadState(
        messageId,
        readStateFromOptions(opts),
      );
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Message ${messageId} marked as ${res.is_read ? 'read' : 'unread'}`);
    });

  messages
    .command('reply')
    .description('Reply from the original inbox address (counts toward email usage)')
    .argument('<message-id>', 'ID of the message to reply to')
    .requiredOption('--idempotency-key <key>', 'Stable idempotency key for the reply (8-200 characters)')
    .option('--text <text>', 'Plain-text reply body')
    .option('--text-file <path>', 'Read the plain-text reply body from a file')
    .option('--html <html>', 'HTML reply body')
    .option('--html-file <path>', 'Read the HTML reply body from a file')
    .option('--to <email>', 'Override the reply recipient')
    .option('--subject <subject>', 'Override the generated Re: subject')
    .option('--from-name <name>', 'Sender display name')
    .option('--attachment <path>', 'Attach a local file (repeatable; up to 10 files / 6MB total)', (v, p: string[]) => [...p, v], [] as string[])
    .option('--inline <content-id=path>', 'Add an inline image referenced by HTML cid: (repeatable)', (v, p: string[]) => [...p, v], [] as string[])
    .action(async (
      messageId: string,
      opts: {
        idempotencyKey: string;
        text?: string;
        textFile?: string;
        html?: string;
        htmlFile?: string;
        to?: string;
        subject?: string;
        fromName?: string;
        attachment?: string[];
        inline?: string[];
      },
      command: Command,
    ) => {
      if (!/^[A-Za-z0-9._:-]{8,200}$/.test(opts.idempotencyKey)) {
        throw new Error('--idempotency-key must be 8-200 letters, digits, or . _ : -');
      }
      const text = await readOptionalFile(opts.text, opts.textFile, '--text');
      const html = await readOptionalFile(opts.html, opts.htmlFile, '--html');
      if (!text && !html) throw new Error('A reply needs --text/--text-file or --html/--html-file');
      if (opts.inline?.length && !html) throw new Error('--inline requires an HTML body');
      const attachments = await loadEmailAttachments(opts.attachment, opts.inline);
      const res = await (await clientFor(command)).replyToInboxMessage(messageId, {
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(opts.to ? { to: opts.to.trim() } : {}),
        ...(opts.subject ? { subject: opts.subject } : {}),
        ...(opts.fromName ? { fromName: opts.fromName } : {}),
        ...(attachments.length ? { attachments } : {}),
      }, opts.idempotencyKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (res.status === 'processing') {
        info(`Reply still processing; request ID: ${res.request_id}`);
        return;
      }
      success(`Reply sent${res.to ? ` to ${res.to}` : ''}`);
      if (res.request_id) info(`Request ID: ${res.request_id}`);
      if (res.thread_id) info(`Thread ID: ${res.thread_id}`);
    });

  messages
    .command('forward')
    .description('Forward a message from the original inbox address (counts toward email usage); original attachments are included by default')
    .argument('<message-id>', 'ID of the message to forward')
    .requiredOption('--to <email>', 'Forward to this address')
    .requiredOption('--idempotency-key <key>', 'Stable idempotency key for the forward (8-200 characters)')
    .option('--text <text>', 'Plain-text note (placed above the forwarded content)')
    .option('--text-file <path>', 'Read the plain-text note from a file')
    .option('--html <html>', 'HTML note')
    .option('--html-file <path>', 'Read the HTML note from a file')
    .option('--subject <subject>', 'Override the generated Fwd: subject')
    .option('--from-name <name>', 'Sender display name')
    .option('--no-attachments', 'Do not forward the original attachments')
    .option('--attachment <path>', 'Attach an extra local file (repeatable; up to 10 files / 6MB total)', (v, p: string[]) => [...p, v], [] as string[])
    .action(async (
      messageId: string,
      opts: {
        to: string;
        idempotencyKey: string;
        text?: string;
        textFile?: string;
        html?: string;
        htmlFile?: string;
        subject?: string;
        fromName?: string;
        attachments: boolean;
        attachment?: string[];
      },
      command: Command,
    ) => {
      if (!/^[A-Za-z0-9._:-]{8,200}$/.test(opts.idempotencyKey)) {
        throw new Error('--idempotency-key must be 8-200 letters, digits, or . _ : -');
      }
      const text = await readOptionalFile(opts.text, opts.textFile, '--text');
      const html = await readOptionalFile(opts.html, opts.htmlFile, '--html');
      const attachments = await loadEmailAttachments(opts.attachment, []);
      const res = await (await clientFor(command)).forwardInboxMessage(messageId, {
        to: opts.to.trim(),
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(opts.subject ? { subject: opts.subject } : {}),
        ...(opts.fromName ? { fromName: opts.fromName } : {}),
        ...(opts.attachments === false ? { includeAttachments: false } : {}),
        ...(attachments.length ? { attachments } : {}),
      }, opts.idempotencyKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (res.status === 'processing') {
        info(`Forward still processing; request ID: ${res.request_id}`);
        return;
      }
      success(`Forwarded to ${res.to ?? opts.to}`);
      if (res.request_id) info(`Request ID: ${res.request_id}`);
      if (res.thread_id) info(`Thread ID: ${res.thread_id}`);
    });

  messages
    .command('delete')
    .description('Permanently delete one message with its stored body and attachments')
    .argument('<message-id>', 'Message ID')
    .requiredOption('--yes', 'Confirm permanent deletion')
    .action(async (messageId: string, _opts: { yes: boolean }, command: Command) => {
      const res = await (await clientFor(command)).deleteInboxMessage(messageId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Message ${messageId} deleted`);
    });

  const threads = inbox.command('threads').description('Browse the inbox by thread');

  addMailSearchOptions(threads
    .command('list', { isDefault: true })
    .description('List or search thread summaries page by page (a thread matches if any of its messages does); reading does not change read state')
    .option('--address-id <id>', 'Only show this inbox address')
    .option('--limit <n>', 'Number of results', parsePositiveInteger)
    .option('--cursor <cursor>', 'Next-page cursor returned by the server')
    .option('--folder <folder>', 'inbox / quarantine (default inbox)', parseInboxFolder)
    .option('--sender-domain <domain>', 'Filter by sender domain (case-insensitive exact domain match, subdomains excluded; indexed)'), INBOX_SEARCH_LABELS)
    .action(async (opts: InboxListOptions, command) => {
      const res = await (await clientFor(command)).listInboxThreads(opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.threads.length) return info('No threads');
      printTable(['Time', 'Unread', 'Messages', 'Subject', 'Thread ID'], res.threads.map((thread) => [
        formatTimestamp(thread.last_received_at),
        String(thread.unread_count),
        String(thread.message_count),
        truncate(thread.latest_message?.subject),
        thread.thread_id,
      ]));
      if (res.cursor) info(`Next page cursor: ${res.cursor}`);
    });

  threads
    .command('show')
    .description('Show every message in a thread; reading does not change read state')
    .argument('<thread-id>', 'Thread ID')
    .option('--folder <folder>', 'inbox / quarantine (default inbox)', parseInboxFolder)
    .action(async (threadId: string, opts: { folder?: string }, command) => {
      const res = await (await clientFor(command)).getInboxThread(threadId, opts.folder);
      if (getOutputFormat() === 'json') return printJSON(res);
      for (const [index, message] of res.messages.entries()) {
        if (index > 0) info('\n---\n');
        printMessage(message);
      }
    });

  threads
    .command('read-state')
    .description('Set the read state of every inbound message in a thread')
    .argument('<thread-id>', 'Thread ID')
    .option('--read', 'Mark as read')
    .option('--unread', 'Mark as unread')
    .action(async (
      threadId: string,
      opts: { read?: boolean; unread?: boolean },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).setInboxThreadReadState(
        threadId,
        readStateFromOptions(opts),
      );
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Thread ${threadId} marked as ${res.is_read ? 'read' : 'unread'} (${res.updated_count} messages updated)`);
    });

  const replies = inbox.command('replies').description('Look up idempotent reply requests');

  replies
    .command('show')
    .argument('<request-id>', 'Reply request ID')
    .action(async (requestId: string, _opts, command) => {
      const res = await (await clientFor(command)).getInboxReply(requestId);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`Status: ${res.request.status}`);
      info(`Reply message ID: ${res.request.reply_email_id}`);
      if (res.request.response_status != null) info(`Response status: ${res.request.response_status}`);
    });

  const attachments = inbox.command('attachments').description('Download private inbound attachments');

  attachments
    .command('download')
    .argument('<message-id>', 'Message ID')
    .argument('<attachment-id>', 'Attachment ID')
    .argument('[output]', 'Output file path (defaults to the original file name)')
    .option('--force', 'Overwrite an existing output file')
    .action(async (
      messageId: string,
      attachmentId: string,
      output: string | undefined,
      opts: { force?: boolean },
      command: Command,
    ) => {
      const result = await (await clientFor(command)).downloadInboxAttachment(messageId, attachmentId);
      const target = resolvePath(output || basename(result.filename));
      try {
        await fs.writeFile(target, result.bytes, { flag: opts.force ? 'w' : 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`Output file already exists: ${target} (add --force to overwrite)`);
        }
        throw error;
      }
      if (getOutputFormat() === 'json') {
        return printJSON({
          success: true,
          path: target,
          bytes: result.bytes.byteLength,
          contentType: result.contentType,
        });
      }
      success(`Attachment saved to ${target}`);
    });

  const webhook = inbox.command('webhook').description('Configure the signed inbound webhook');

  webhook
    .command('get', { isDefault: true })
    .alias('show')
    .description('Show the current inbound webhook configuration')
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).getInboxWebhook();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.webhook) return info('No inbound webhook configured');
      info(`URL: ${res.webhook.url}`);
      info(`Status: ${res.webhook.active ? 'active' : 'disabled'}`);
      info(`Body format: ${res.webhook.bodyFormat}`);
      info(`Strip quotes: ${res.webhook.stripQuotes ? 'on' : 'off'}`);
      info(`Events: ${res.webhook.events.join(', ')}`);
    });

  webhook
    .command('set')
    .description('Create or update the inbound webhook')
    .requiredOption('--url <url>', 'Public HTTPS callback URL')
    .option('--body-format <format>', 'Pushed body format: text / markdown / html', parseInboxBodyFormat)
    .option('--strip-quotes', 'Strip quoted reply history added by mail clients when pushing')
    .option('--no-strip-quotes', 'Keep the full quoted history when pushing')
    .option('--signing-secret <secret>', 'Custom signing secret (32-256 characters)')
    .option('--rotate-secret', 'Generate a new signing secret')
    .action(async (
      opts: {
        url: string;
        bodyFormat?: InboxBodyFormat;
        stripQuotes?: boolean;
        signingSecret?: string;
        rotateSecret?: boolean;
      },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).setInboxWebhook({
        url: opts.url.trim(),
        ...(opts.bodyFormat ? { bodyFormat: opts.bodyFormat } : {}),
        ...(typeof opts.stripQuotes === 'boolean' ? { stripQuotes: opts.stripQuotes } : {}),
        ...(opts.signingSecret ? { signingSecret: opts.signingSecret } : {}),
        ...(opts.rotateSecret ? { rotateSecret: true } : {}),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Inbound webhook configured: ${res.webhook.url}`);
      info(`Body format: ${res.webhook.bodyFormat}`);
      info(`Strip quotes: ${res.webhook.stripQuotes ? 'on' : 'off'}`);
      if (res.signingSecret) {
        warn('The signing secret is shown only once. Save it now:');
        info(res.signingSecret);
      }
    });

  webhook
    .command('delete')
    .alias('disable')
    .description('Disable the inbound webhook (keeps its configuration and delivery history)')
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).disableInboxWebhook();
      if (getOutputFormat() === 'json') return printJSON(res);
      success(res.disabled ? 'Inbound webhook disabled' : 'No inbound webhook to disable');
    });

  const addressWebhook = webhook
    .command('address')
    .description('Configure a dedicated inbound webhook per inbox address (addresses without one use the global webhook)');

  addressWebhook
    .command('get')
    .description('Show the dedicated webhook for an inbox address')
    .argument('<address-id>', 'Inbox address ID (see mailly inbox addresses list)')
    .action(async (addressId: string, _opts: unknown, command: Command) => {
      const res = await (await clientFor(command)).getInboxWebhookAddressSubscription(addressId);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.subscription) return info('This address has no dedicated webhook and uses the global webhook');
      info(`Address: ${res.subscription.addressId}`);
      info(`URL: ${res.subscription.url}`);
      info(`Status: ${res.subscription.active ? 'active' : 'disabled'}`);
      info(`Body format: ${res.subscription.bodyFormat}`);
      info(`Strip quotes: ${res.subscription.stripQuotes ? 'on' : 'off'}`);
    });

  addressWebhook
    .command('set')
    .description('Create or update the dedicated webhook for an inbox address (that address then pushes only to this URL)')
    .argument('<address-id>', 'Inbox address ID (see mailly inbox addresses list)')
    .requiredOption('--url <url>', 'Public HTTPS callback URL')
    .option('--body-format <format>', 'Pushed body format: text / markdown / html', parseInboxBodyFormat)
    .option('--strip-quotes', 'Strip quoted reply history added by mail clients when pushing')
    .option('--no-strip-quotes', 'Keep the full quoted history when pushing')
    .option('--signing-secret <secret>', 'Custom signing secret (32-256 characters)')
    .option('--rotate-secret', 'Generate a new signing secret')
    .action(async (
      addressId: string,
      opts: {
        url: string;
        bodyFormat?: InboxBodyFormat;
        stripQuotes?: boolean;
        signingSecret?: string;
        rotateSecret?: boolean;
      },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).setInboxWebhookAddressSubscription(addressId, {
        url: opts.url.trim(),
        ...(opts.bodyFormat ? { bodyFormat: opts.bodyFormat } : {}),
        ...(typeof opts.stripQuotes === 'boolean' ? { stripQuotes: opts.stripQuotes } : {}),
        ...(opts.signingSecret ? { signingSecret: opts.signingSecret } : {}),
        ...(opts.rotateSecret ? { rotateSecret: true } : {}),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Dedicated webhook for address ${res.subscription.addressId} configured: ${res.subscription.url}`);
      info(`Body format: ${res.subscription.bodyFormat}`);
      info(`Strip quotes: ${res.subscription.stripQuotes ? 'on' : 'off'}`);
      if (res.signingSecret) {
        warn('The signing secret is shown only once. Save it now:');
        info(res.signingSecret);
      }
    });

  addressWebhook
    .command('delete')
    .alias('remove')
    .description('Delete the dedicated webhook for an inbox address and fall back to the global webhook')
    .argument('<address-id>', 'Inbox address ID')
    .action(async (addressId: string, _opts: unknown, command: Command) => {
      const res = await (await clientFor(command)).removeInboxWebhookAddressSubscription(addressId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(res.removed ? 'Dedicated webhook deleted; this address now uses the global webhook' : 'This address has no dedicated webhook');
    });
}
