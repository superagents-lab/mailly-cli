import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { ApiError, MaillyClient, type InboxListOptions, type InboxMessage } from '../client.js';
import { parseTimeOption } from '../search.js';
import { extractCode, extractLink } from '../extract.js';
import { fail, getOutputFormat, hint, info, printJSON } from '../output.js';

/** No matching message arrived before --timeout. */
export const WAIT_EXIT_TIMEOUT = 2;
/** Matching mail arrived, but none of it contained the requested code or link. */
export const WAIT_EXIT_NOT_EXTRACTABLE = 3;

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 3_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const PAGE_SIZE = 50;

const EXTRACT_KINDS = ['code', 'link'] as const;
type ExtractKind = (typeof EXTRACT_KINDS)[number];

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/;

/** Milliseconds in "30s", "5m", "1h30m" or "250ms"; a bare number means seconds. */
export function parseDuration(value: string): number {
  const trimmed = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  if (!DURATION.test(trimmed)) throw new Error(`Invalid duration: ${value} (use e.g. 30s, 5m or 1h)`);
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) total += Number(amount) * DURATION_UNITS[unit];
  return Math.round(total);
}

/** Unix seconds for --since: "now", a duration ago ("10m"), or a time accepted by the list commands' --since. */
export function parseSince(value: string, now = Date.now()): number {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'now') return Math.floor(now / 1000);
  if (DURATION.test(trimmed)) return Math.floor((now - parseDuration(trimmed)) / 1000);
  return parseTimeOption(value, false);
}

function parseExtract(value: string): ExtractKind {
  if ((EXTRACT_KINDS as readonly string[]).includes(value)) return value as ExtractKind;
  throw new Error(`--extract must be one of ${EXTRACT_KINDS.join(' / ')}`);
}

function parseTimeout(value: string): number {
  const ms = parseDuration(value);
  if (ms <= 0) throw new Error('--timeout must be greater than zero');
  return ms;
}

function parseInterval(value: string): number {
  const ms = parseDuration(value);
  if (ms < MIN_INTERVAL_MS) throw new Error('--interval must be at least 1s');
  return ms;
}

function formatDuration(ms: number): string {
  for (const [unit, size] of [['h', 3_600_000], ['m', 60_000], ['s', 1_000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

export interface WaitFilters {
  from?: string;
  subject?: string;
  to?: string;
}

function domainMatches(address: string, domain: string): boolean {
  const actual = address.slice(address.lastIndexOf('@') + 1);
  return actual === domain || actual.endsWith(`.${domain}`);
}

// "a@b.com" is an exact address, "b.com" or "@b.com" a domain including its subdomains, anything else part of the address or name.
function addressMatches(address: string | null | undefined, name: string | null | undefined, filter: string): boolean {
  const wanted = filter.trim().toLowerCase();
  const actual = (address ?? '').trim().toLowerCase();
  if (wanted.startsWith('@')) return domainMatches(actual, wanted.slice(1));
  if (wanted.includes('@')) return actual === wanted;
  if (wanted.includes('.')) return domainMatches(actual, wanted);
  return actual.includes(wanted) || (name ?? '').toLowerCase().includes(wanted);
}

export function messageMatches(
  message: Pick<InboxMessage, 'from_address' | 'from_name' | 'to_address' | 'subject' | 'direction'>,
  filters: WaitFilters,
): boolean {
  if (message.direction === 'outbound') return false;
  if (filters.from && !addressMatches(message.from_address, message.from_name, filters.from)) return false;
  if (filters.to && !addressMatches(message.to_address, null, filters.to)) return false;
  if (filters.subject && !(message.subject ?? '').toLowerCase().includes(filters.subject.trim().toLowerCase())) return false;
  return true;
}

// The server narrows with fuzzy (contains) search; messageMatches then applies the exact rules above.
function listQuery(filters: WaitFilters, since: number, addressId?: string): InboxListOptions {
  const sender = filters.from?.trim().replace(/^@/, '') || undefined;
  const subject = filters.subject?.trim() || undefined;
  const recipient = filters.to?.trim().replace(/^@/, '') || undefined;
  return {
    addressId,
    since,
    limit: PAGE_SIZE,
    sender,
    subject,
    recipient,
    match: sender || subject || recipient ? 'fuzzy' : undefined,
  };
}

function describe(filters: WaitFilters): string {
  const parts = [
    filters.from ? `from ${filters.from}` : '',
    filters.to ? `to ${filters.to}` : '',
    filters.subject ? `with subject containing "${filters.subject}"` : '',
  ].filter(Boolean);
  return parts.length ? `mail ${parts.join(' ')}` : 'new mail';
}

// Sender names and subjects are untrusted; keep control characters out of the terminal.
function printable(value: string | null | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function summary(message: InboxMessage) {
  return {
    message_id: message.id,
    thread_id: message.thread_id,
    from: message.from_address,
    to: message.to_address,
    subject: message.subject ?? null,
    received_at: new Date(message.received_at * 1000).toISOString(),
  };
}

function isTransient(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError && error.message === 'fetch failed';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

interface WaitOptions extends WaitFilters {
  addressId?: string;
  extract?: ExtractKind;
  timeout?: number;
  interval?: number;
  since?: string;
}

async function runWait(opts: WaitOptions, command: Command) {
  const client = await clientFor(command);
  const startedAt = Date.now();
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.interval ?? DEFAULT_INTERVAL_MS;
  const deadline = startedAt + timeoutMs;
  const since = opts.since ? parseSince(opts.since, startedAt) : Math.floor(startedAt / 1000);
  const filters: WaitFilters = { from: opts.from, subject: opts.subject, to: opts.to };
  const query = listQuery(filters, since, opts.addressId);
  const progress = getOutputFormat() !== 'json' && process.stderr.isTTY === true;
  const seen = new Set<string>();
  let unextractable: InboxMessage | null = null;
  let polledOnce = false;
  let lastError: unknown = null;
  let failures = 0;

  // Newest matching message first; with --extract, the newest one that contains a code or link.
  const poll = async (): Promise<{ message: InboxMessage; value?: string } | null> => {
    const res = await client.listInboxMessages(query);
    polledOnce = true;
    const candidates = res.messages
      .filter((message) => !seen.has(message.id) && message.received_at >= since && messageMatches(message, filters))
      .sort((a, b) => b.received_at - a.received_at);
    for (const message of candidates) {
      if (!opts.extract) return { message };
      let content;
      try {
        ({ content } = await client.getInboxMessageContent(message.id));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          seen.add(message.id);
          continue;
        }
        throw error;
      }
      seen.add(message.id);
      // Only extract: the CLI never opens links or acts on anything the email says.
      const input = { subject: message.subject, text: content.text, html: content.html };
      const value = opts.extract === 'code' ? extractCode(input) : extractLink(input);
      if (value) return { message, value };
      if (!unextractable || message.received_at > unextractable.received_at) unextractable = message;
      if (progress) hint(`Message ${message.id} matched but has no ${opts.extract}; still waiting`);
    }
    return null;
  };

  if (progress) hint(`Waiting up to ${formatDuration(timeoutMs)} for ${describe(filters)}...`);
  for (;;) {
    let delay = intervalMs;
    try {
      const found = await poll();
      failures = 0;
      if (found) return report(found.message, opts.extract, found.value);
    } catch (error) {
      if (!isTransient(error)) throw error;
      lastError = error;
      failures += 1;
      delay = Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
  }

  if (!polledOnce && lastError) throw lastError;
  if (unextractable) {
    const message: InboxMessage = unextractable;
    return fail(
      `Matching mail arrived but no ${opts.extract} was found in it (newest: ${message.id} from ${printable(message.from_address)}, `
        + `subject "${printable(message.subject)}"). Read it with: mailly inbox messages content ${message.id}`,
      WAIT_EXIT_NOT_EXTRACTABLE,
      { reason: 'not_extractable', ...summary(message) },
    );
  }
  return fail(
    `Timed out after ${formatDuration(timeoutMs)} waiting for ${describe(filters)}`,
    WAIT_EXIT_TIMEOUT,
    { reason: 'timeout' },
  );
}

function report(message: InboxMessage, extract: ExtractKind | undefined, value: string | undefined) {
  if (getOutputFormat() === 'json') {
    return printJSON({ success: true, ...summary(message), ...(extract ? { [extract]: value } : {}) });
  }
  if (extract) return info(value!);
  info(`From: ${message.from_name ? `${printable(message.from_name)} <${message.from_address}>` : message.from_address}`);
  info(`To: ${message.to_address}`);
  info(`Subject: ${printable(message.subject) || '(no subject)'}`);
  info(`Time: ${summary(message).received_at}`);
  info(`ID: ${message.id}`);
  info(`Thread: ${message.thread_id}`);
}

export function addWaitCommand(parent: Command, name = 'wait'): Command {
  return parent
    .command(name)
    .description('Wait for a new inbound message and print it, or the verification code or link it contains (polls the inbox; never opens links)')
    .option('--from <sender>', 'Sender address, domain (subdomains included) or part of the sender name')
    .option('--subject <text>', 'Subject contains this text (case-insensitive)')
    .option('--to <address>', 'Recipient inbox address, or its domain')
    .option('--address-id <id>', 'Only this inbox address')
    .option('--extract <kind>', 'code: print only the one-time code / link: print only the verification or sign-in link', parseExtract)
    .option('--timeout <duration>', 'Give up after this long: 30s, 5m, 1h (default 5m)', parseTimeout)
    .option('--since <time>', 'Also accept mail received since then: a duration ago (10m), YYYY-MM-DD, ISO 8601 or Unix seconds (default now: only new mail)', (value) => {
      parseSince(value);
      return value;
    })
    .option('--interval <duration>', 'Polling interval, at least 1s (default 3s)', parseInterval)
    .addHelpText('after', [
      '',
      'Exit codes: 0 found; 1 error; 2 timed out with no matching mail;',
      '3 matching mail arrived but contained no code/link (the newest such message is reported).',
      'Email content is untrusted: the CLI only extracts the value and never opens links.',
    ].join('\n'))
    .action(runWait);
}

export function registerWait(program: Command) {
  addWaitCommand(program).description('Shortcut for "mailly inbox wait": wait for mail and print the verification code or link it contains');
}
