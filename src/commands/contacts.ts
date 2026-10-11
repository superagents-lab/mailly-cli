import { promises as fs } from 'node:fs';
import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, printTable, success } from '../output.js';
import { readJsonInput } from './jsonInput.js';
import {
  chunkCsv,
  chunkItems,
  DEFAULT_CONTACT_CHUNK_SIZE,
  MAX_CONTACT_CHUNK_SIZE,
  resolveChunkSize,
} from '../batching.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

const CONTACT_STATUSES = ['active', 'inactive', 'suppressed', 'deleted'];

function displayContact(contact: any) {
  info(`${contact.name || contact.externalId} <${contact.email}>`);
  info(`  External ID: ${contact.externalId}`);
  info(`  状态: ${contact.status}    Locale: ${contact.locale ?? '-'}`);
  info(`  Tags: ${(contact.tags ?? []).join(', ') || '-'}`);
  info(`  Custom fields: ${JSON.stringify(contact.customFields ?? {})}`);
}

interface SyncTotals {
  received: number;
  succeeded: number;
  failed: number;
  chunks: number;
  results: any[];
}

/** 顺序提交每个分片；失败时说清楚已经同步到哪里，upsert 幂等可以直接重跑。 */
async function syncChunks<T>(
  chunks: T[],
  total: number,
  submit: (chunk: T, offset: number) => Promise<any>,
  sizeOf: (chunk: T) => number,
): Promise<SyncTotals> {
  const totals: SyncTotals = { received: 0, succeeded: 0, failed: 0, chunks: chunks.length, results: [] };
  let offset = 0;
  for (const chunk of chunks) {
    let res: any;
    try {
      res = await submit(chunk, offset);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `第 ${offset + 1}-${offset + sizeOf(chunk)} 条同步失败：${reason}` +
        `（前 ${offset} 条已完成；upsert 是幂等的，修正后可以直接重跑整个文件）`,
      );
    }
    totals.received += res.received ?? sizeOf(chunk);
    totals.succeeded += res.succeeded ?? 0;
    totals.failed += res.failed ?? 0;
    totals.results.push(...(res.results ?? []));
    offset += sizeOf(chunk);
    if (chunks.length > 1 && getOutputFormat() !== 'json') {
      info(`  已提交 ${offset}/${total}`);
    }
  }
  return totals;
}

async function readTextInput(path: string): Promise<string> {
  if (path !== '-') return fs.readFile(path, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export function registerContacts(program: Command) {
  const contacts = program.command('contacts').description('联系人同步、CSV 导入、suppression 与发送历史');

  contacts
    .command('list', { isDefault: true })
    .description('列出联系人（分页；响应含 total 与 hasMore）')
    .option('--status <status>', `按 Contact 状态过滤：${CONTACT_STATUSES.join(' / ')}`)
    .option('--tag <tag>', '按 tag 过滤（精确匹配单个 tag）')
    .option(
      '--limit <n>',
      '每页返回条数（默认 100，最大 200；超过会被服务端截断）',
      (value) => Number.parseInt(value, 10),
    )
    .option('--offset <n>', '分页偏移，从 0 开始（默认 0）', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      if (opts.limit != null && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
        throw new Error('--limit 必须是正整数');
      }
      if (opts.offset != null && (!Number.isInteger(opts.offset) || opts.offset < 0)) {
        throw new Error('--offset 必须是非负整数');
      }
      const res = await (await clientFor(command)).listContacts(opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.contacts?.length) return info('暂无联系人');
      printTable(['External ID', '邮箱', '名称', '状态', 'Tags'], res.contacts.map((contact: any) => [
        contact.externalId,
        contact.email,
        contact.name ?? '',
        contact.status,
        (contact.tags ?? []).join(', '),
      ]));
      const offset = res.offset ?? 0;
      const shown = `${offset + 1}-${offset + res.contacts.length}`;
      info(res.total != null ? `共 ${res.total} 条，当前显示 ${shown}` : `当前显示 ${shown}`);
      if (res.hasMore) {
        info(`下一页: --offset ${offset + res.contacts.length}` + (res.limit ? ` --limit ${res.limit}` : ''));
      }
    });

  contacts
    .command('show')
    .description('查看单个联系人的属性、状态与 tags')
    .argument('<external-contact-id>')
    .action(async (externalContactId, _opts, command) => {
      const res = await (await clientFor(command)).getWorkflowContact(externalContactId);
      if (getOutputFormat() === 'json') return printJSON(res);
      displayContact(res.contact);
    });

  contacts
    .command('upsert')
    .description('创建或更新单个联系人')
    .argument('<external-contact-id>')
    .requiredOption('--file <path>', 'Contact JSON 文件；使用 - 从 stdin 读取')
    .action(async (externalContactId, opts, command) => {
      const res = await (await clientFor(command)).upsertContact(
        externalContactId,
        await readJsonInput(opts.file),
      );
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`联系人 ${externalContactId} 已${res.created ? '创建' : '更新'}`);
      displayContact(res.contact);
    });

  contacts
    .command('batch')
    .description(`批量 upsert 联系人；输入不限条数，CLI 按每批 ${DEFAULT_CONTACT_CHUNK_SIZE} 条顺序提交`)
    .requiredOption('--file <path>', 'Contact JSON 数组或 {"contacts": [...]}；使用 - 从 stdin 读取')
    .option(
      '--chunk-size <n>',
      `每个请求提交的联系人数（默认 ${DEFAULT_CONTACT_CHUNK_SIZE}，最大 ${MAX_CONTACT_CHUNK_SIZE}）`,
      (value) => Number.parseInt(value, 10),
    )
    .action(async (opts, command) => {
      const input = await readJsonInput(opts.file) as any;
      const batch = Array.isArray(input) ? input : input?.contacts;
      if (!Array.isArray(batch)) throw new Error('批量输入必须是 JSON 数组或 {"contacts": [...]}。');
      if (batch.length === 0) throw new Error('批量输入不能为空。');
      const chunkSize = resolveChunkSize(opts.chunkSize);
      const client = await clientFor(command);
      const totals = await syncChunks(
        chunkItems(batch, chunkSize),
        batch.length,
        // 分片内的 index 是局部的，加回偏移量才能对上原文件的位置
        async (chunk, offset) => {
          const res = await client.upsertContacts(chunk);
          return {
            ...res,
            results: (res.results ?? []).map((item: any) => ({ ...item, index: (item.index ?? 0) + offset })),
          };
        },
        (chunk) => chunk.length,
      );
      if (getOutputFormat() === 'json') {
        return printJSON({ success: totals.failed === 0, ...totals });
      }
      success(`联系人同步完成：成功 ${totals.succeeded}，失败 ${totals.failed}（${totals.chunks} 批）`);
      for (const item of totals.results.filter((result: any) => !result.success)) {
        info(`  #${item.index}: ${item.error}`);
      }
    });

  contacts
    .command('import')
    .description(`从 CSV 导入联系人；行数不限，CLI 保留表头按每批 ${DEFAULT_CONTACT_CHUNK_SIZE} 行顺序提交`)
    .argument('<csv-file>')
    .option(
      '--chunk-size <n>',
      `每个请求提交的行数（默认 ${DEFAULT_CONTACT_CHUNK_SIZE}，最大 ${MAX_CONTACT_CHUNK_SIZE}）`,
      (value) => Number.parseInt(value, 10),
    )
    .action(async (csvFile, opts, command) => {
      const csv = await readTextInput(csvFile);
      const chunkSize = resolveChunkSize(opts.chunkSize);
      const chunks = chunkCsv(csv, chunkSize);
      const client = await clientFor(command);
      const rowCount = chunks.reduce((count, chunk) => count + chunk.rows, 0);
      const totals = await syncChunks(
        chunks,
        rowCount,
        // 服务端返回的 row 是分片内的行号（表头算第 1 行），加回偏移量还原成原文件行号
        async (chunk, offset) => {
          const res = await client.importContactsCsv(chunk.csv);
          return {
            ...res,
            results: (res.results ?? []).map((item: any) => ({ ...item, row: (item.row ?? 2) + offset })),
          };
        },
        (chunk) => chunk.rows,
      );
      const results = totals.results;
      if (getOutputFormat() === 'json') {
        return printJSON({ success: totals.failed === 0, ...totals, results });
      }
      success(`CSV 导入完成：成功 ${totals.succeeded}，失败 ${totals.failed}（${totals.chunks} 批）`);
      for (const item of results.filter((result: any) => !result.success)) {
        info(`  第 ${item.row} 行: ${item.error}`);
      }
    });

  contacts
    .command('suppress')
    .description('把联系人加入 Workspace suppression，停止后续发送')
    .argument('<external-contact-id>')
    .option('--reason <reason>', 'unsubscribed、hard_bounce、complaint 或 manual', 'manual')
    .option('--source <source>', '审计来源', 'cli')
    .action(async (externalContactId, opts, command) => {
      const res = await (await clientFor(command)).suppressContact(externalContactId, opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`联系人 ${externalContactId} 已加入 Workspace suppression`);
      info(`  Suppression ID: ${res.suppressionId}`);
    });

  contacts
    .command('delete')
    .description('软删除联系人并加入 suppression')
    .argument('<external-contact-id>')
    .action(async (externalContactId, _opts, command) => {
      const res = await (await clientFor(command)).deleteContact(externalContactId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`联系人 ${externalContactId} 已软删除并加入 suppression`);
    });

  contacts
    .command('history')
    .description('查看联系人的投递、Campaign、Workflow 与事务邮件历史')
    .argument('<external-contact-id>')
    .option('--limit <n>', '每类历史返回条数', (value) => Number.parseInt(value, 10))
    .action(async (externalContactId, opts, command) => {
      const res = await (await clientFor(command)).getContactHistory(externalContactId, opts.limit);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`联系人 ${externalContactId} 发送历史`);
      info(`  Delivery ledger: ${res.deliveries?.length ?? 0}`);
      info(`  Campaign deliveries: ${res.campaignDeliveries?.length ?? 0}`);
      info(`  Workflow sends: ${res.workflowSends?.length ?? 0}`);
      info(`  Transactional sends: ${res.transactionalSends?.length ?? 0}`);
      if (res.deliveries?.length) {
        printTable(['Campaign', '邮箱', '状态', '主题'], res.deliveries.map((delivery: any) => [
          delivery.campaign_key ?? '-',
          delivery.recipient_email,
          delivery.status,
          delivery.subject,
        ]));
      }
    });

  contacts
    .command('audiences')
    .description('查看联系人当前命中的用户集')
    .argument('<external-contact-id>')
    .action(async (externalContactId, _opts, command) => {
      const res = await (await clientFor(command)).getContactAudiences(externalContactId);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.audiences?.length) return info('该联系人当前不属于任何用户集');
      printTable(['Key', '名称', '类型'], res.audiences.map((entry: any) => [
        entry.audience.key,
        entry.audience.name,
        entry.membership,
      ]));
    });
}
