import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON, printTable, success } from '../output.js';

function fmtTimestamp(ts: string): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function registerLogs(program: Command) {
  const logs = program
    .command('logs')
    .description('消费日志')
    .action(async (_opts, command) => {
      // default action: list latest logs
      await listLogs(command, {});
    });

  logs
    .command('list', { isDefault: true })
    .description('列出最近的消费日志（按时间倒序）')
    .option('--limit <n>', '返回条数（默认 50，最大 100）', (v) => parseInt(v, 10))
    .option('--offset <n>', '分页偏移量（默认 0）', (v) => parseInt(v, 10))
    .action(async (opts, command) => {
      await listLogs(command, opts);
    });

  logs
    .command('export')
    .description('下载完整消费日志为 CSV 文件')
    .argument('[output]', '输出文件路径（默认使用服务端返回的文件名）')
    .action(async (output: string | undefined, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const { filename, csv } = await client.downloadLogsCSV();

      const target = resolvePath(output || filename);
      await fs.writeFile(target, csv, 'utf8');

      if (getOutputFormat() === 'json') {
        printJSON({ success: true, path: target, bytes: Buffer.byteLength(csv, 'utf8') });
        return;
      }
      success(`已保存日志到 ${target}`);
    });
}

async function listLogs(
  command: any,
  opts: { limit?: number; offset?: number }
) {
  const root = command.parent?.parent || command.parent;
  const globalOpts = root.opts() as { apiKey?: string; baseUrl?: string };
  const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
  const client = new MaillyClient(auth);
  const res = await client.listLogs(opts.limit, opts.offset);

  if (getOutputFormat() === 'json') {
    printJSON(res);
    return;
  }

  if (!res.logs.length) {
    info('暂无消费记录');
    return;
  }

  const rows = res.logs.map((l) => [
    fmtTimestamp(l.timestamp),
    String(l.amount_deducted),
    l.send_mode || 'single',
    String(l.recipient_count ?? 1),
    truncate(l.from_email, 28),
    truncate(l.target_email, 28),
    truncate(l.subject, 32),
  ]);

  printTable(['时间', '扣费', '模式', '收件数', '发件人', '收件人', '主题'], rows);
  info(c.dim(`显示 ${res.logs.length} 条 (offset=${res.offset}, limit=${res.limit})`));
}
