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

// 只写日期时按本机时区的自然日：--since 取当天零点，--until 包含当天（取次日零点作为不含的上界）。
// 带时间的 ISO 8601 按其自身时区；纯数字视为 Unix 秒。统一换算成 Unix 秒发给 API。
export function parseTimeOption(value: string, inclusiveDay: boolean): number {
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    const [, year, month, day] = dateOnly.map(Number);
    const start = new Date(year, month - 1, day);
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
      throw new Error(`无效日期：${value}`);
    }
    if (inclusiveDay) start.setDate(start.getDate() + 1);
    return Math.floor(start.getTime() / 1000);
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const millis = Date.parse(trimmed);
  if (!Number.isFinite(millis)) throw new Error(`无法识别的时间：${value}（用 YYYY-MM-DD、ISO 8601 或 Unix 秒）`);
  return Math.floor(millis / 1000);
}

function parseMatch(value: string): MailSearchMatch {
  if ((MAIL_SEARCH_MATCH_MODES as readonly string[]).includes(value)) return value as MailSearchMatch;
  throw new Error(`--match 只能是 ${MAIL_SEARCH_MATCH_MODES.join(' / ')}`);
}

// 收件箱与发件箱列表共用的搜索参数；与 API 同名，只检索元数据，不检索正文。
export function addMailSearchOptions(command: Command, labels: { sender: string; query: string; time: string }): Command {
  return command
    .option('--recipient <email>', '按收件人搜索（匹配方式见 --match）')
    .option('--sender <email>', labels.sender)
    .option('--subject <text>', '按主题搜索（匹配方式见 --match）')
    .option('--match <mode>', 'recipient/sender/subject 的匹配方式：exact（默认，忽略大小写的完整匹配）/ fuzzy（包含）', parseMatch)
    .option('--query <text>', labels.query)
    .option('--since <time>', `${labels.time}下界（含）：YYYY-MM-DD（本机时区当天零点）、ISO 8601 或 Unix 秒`, (value) => parseTimeOption(value, false))
    .option('--until <time>', `${labels.time}上界：YYYY-MM-DD 包含当天；ISO 8601 / Unix 秒为不含的精确上界`, (value) => parseTimeOption(value, true));
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
