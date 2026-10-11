import type { Command } from 'commander';

export const MAIL_SEARCH_MATCH_MODES = ['exact', 'fuzzy'] as const;
export type MailSearchMatch = (typeof MAIL_SEARCH_MATCH_MODES)[number];

export interface MailSearchOptions {
  recipient?: string;
  sender?: string;
  subject?: string;
  match?: MailSearchMatch;
  query?: string;
  since?: number;
  until?: number;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// A bare date is a calendar day in the local time zone: --since starts at midnight, --until includes the whole day (next midnight is the exclusive bound).
// ISO 8601 with a time uses its own zone; bare numbers are Unix seconds. Everything is sent to the API as Unix seconds.
export function parseTimeOption(value: string, inclusiveDay: boolean): number {
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    const [, year, month, day] = dateOnly.map(Number);
    const start = new Date(year, month - 1, day);
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
      throw new Error(`Invalid date: ${value}`);
    }
    if (inclusiveDay) start.setDate(start.getDate() + 1);
    return Math.floor(start.getTime() / 1000);
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const millis = Date.parse(trimmed);
  if (!Number.isFinite(millis)) throw new Error(`Unrecognized time: ${value} (use YYYY-MM-DD, ISO 8601, or Unix seconds)`);
  return Math.floor(millis / 1000);
}

function parseMatch(value: string): MailSearchMatch {
  if ((MAIL_SEARCH_MATCH_MODES as readonly string[]).includes(value)) return value as MailSearchMatch;
  throw new Error(`--match must be one of ${MAIL_SEARCH_MATCH_MODES.join(' / ')}`);
}

// Search options shared by inbox and outbox lists; named like the API, they match metadata only, never the body.
export function addMailSearchOptions(command: Command, labels: { sender: string; query: string; time: string }): Command {
  return command
    .option('--recipient <email>', 'Search by recipient (see --match for matching)')
    .option('--sender <email>', labels.sender)
    .option('--subject <text>', 'Search by subject (see --match for matching)')
    .option('--match <mode>', 'How recipient/sender/subject match: exact (default, case-insensitive full match) / fuzzy (contains)', parseMatch)
    .option('--query <text>', labels.query)
    .option('--since <time>', `${labels.time} lower bound (inclusive): YYYY-MM-DD (local midnight), ISO 8601, or Unix seconds`, (value) => parseTimeOption(value, false))
    .option('--until <time>', `${labels.time} upper bound: YYYY-MM-DD includes that day; ISO 8601 / Unix seconds are an exact exclusive bound`, (value) => parseTimeOption(value, true));
}

export function mailSearchQuery(options: MailSearchOptions) {
  return {
    recipient: options.recipient,
    sender: options.sender,
    subject: options.subject,
    match: options.match,
    q: options.query,
    since: options.since,
    until: options.until,
  };
}
