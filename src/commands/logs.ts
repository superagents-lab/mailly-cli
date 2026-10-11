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
    .description('Usage logs')
    .action(async (_opts, command) => {
      // default action: list latest logs
      await listLogs(command, {});
    });

  logs
    .command('list', { isDefault: true })
    .description('List recent usage logs (newest first)')
    .option('--limit <n>', 'Number of results (default 50, max 100)', (v) => parseInt(v, 10))
    .option('--offset <n>', 'Pagination offset (default 0)', (v) => parseInt(v, 10))
    .action(async (opts, command) => {
      await listLogs(command, opts);
    });

  logs
    .command('export')
    .description('Download the full usage log as a CSV file')
    .argument('[output]', 'Output file path (defaults to the file name from the server)')
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
      success(`Saved logs to ${target}`);
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
    info('No usage records');
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

  printTable(['Time', 'Charge', 'Mode', 'Recipients', 'From', 'To', 'Subject'], rows);
  info(c.dim(`Showing ${res.logs.length} (offset=${res.offset}, limit=${res.limit})`));
}
