import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, printTable, success } from '../output.js';
import { readJsonInput } from './jsonInput.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

export function registerEvents(program: Command) {
  const events = program.command('events').description('上报和查询 Workflow 事件');

  events
    .command('track')
    .requiredOption('--file <path>', '事件 JSON 文件；使用 - 从 stdin 读取')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).trackWorkflowEvent(await readJsonInput(opts.file) as any);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`事件 ${res.event.eventId} 已${res.duplicate ? '幂等接收' : '接收'}`);
      info(`  触发 Workflow Run: ${res.triggeredRunIds?.length ?? 0}`);
      info(`  退出 Workflow Run: ${res.exitedRunIds?.length ?? 0}`);
    });

  events
    .command('batch')
    .requiredOption('--file <path>', 'JSON 数组或 {"events": [...]} 文件；使用 - 从 stdin 读取')
    .action(async (opts, command) => {
      const input = await readJsonInput(opts.file) as any;
      const batch = Array.isArray(input) ? input : input?.events;
      if (!Array.isArray(batch)) throw new Error('批量输入必须是 JSON 数组或 {"events": [...]}。');
      const res = await (await clientFor(command)).trackWorkflowEvents(batch);
      if (getOutputFormat() === 'json') return printJSON(res);
      const succeeded = res.results?.filter((item: any) => item.success).length ?? 0;
      success(`已接收 ${res.received} 个事件，成功 ${succeeded}，失败 ${res.received - succeeded}`);
    });

  events
    .command('show')
    .argument('<event-id>')
    .action(async (eventId, _opts, command) => {
      const res = await (await clientFor(command)).getWorkflowEvent(eventId);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${res.event.eventName} (${res.event.eventId})`);
      info(`  联系人: ${res.event.contact.externalContactId} <${res.event.contact.email}>`);
      info(`  状态: ${res.event.processingStatus}`);
      info(`  发生时间: ${res.event.occurredAt}`);
      info(`  Workflow Run: ${res.runs?.length ?? 0}`);
    });

  events
    .command('replay')
    .argument('<event-id>')
    .action(async (eventId, _opts, command) => {
      const res = await (await clientFor(command)).replayWorkflowEvent(eventId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`失败事件 ${eventId} 已重放`);
    });

  events
    .command('timeline')
    .argument('<external-contact-id>')
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .action(async (externalContactId, opts, command) => {
      const res = await (await clientFor(command)).getWorkflowContactTimeline(externalContactId, opts.limit);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.events?.length) return info('暂无事件');
      printTable(['事件', 'Event ID', '状态', '发生时间', '触发', '退出'], res.events.map((event: any) => [
        event.eventName,
        event.eventId,
        event.processingStatus,
        event.occurredAt,
        String(event.triggeredRunCount ?? 0),
        String(event.exitedRunCount ?? 0),
      ]));
    });
}
