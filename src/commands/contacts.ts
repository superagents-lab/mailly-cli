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
  info(`  Status: ${contact.status}    Locale: ${contact.locale ?? '-'}`);
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

/** Submits chunks in order; on failure, reports how far the sync got. Upserts are idempotent, so a rerun is safe. */
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
        `Sync failed for items ${offset + 1}-${offset + sizeOf(chunk)}: ${reason}` +
        ` (the first ${offset} items are done; upserts are idempotent, so fix the problem and rerun the whole file)`,
      );
    }
    totals.received += res.received ?? sizeOf(chunk);
    totals.succeeded += res.succeeded ?? 0;
    totals.failed += res.failed ?? 0;
    totals.results.push(...(res.results ?? []));
    offset += sizeOf(chunk);
    if (chunks.length > 1 && getOutputFormat() !== 'json') {
      info(`  Submitted ${offset}/${total}`);
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
  const contacts = program.command('contacts').description('Contact sync, CSV import, suppression, and send history');

  contacts
    .command('list', { isDefault: true })
    .description('List contacts (paginated; the response includes total and hasMore)')
    .option('--status <status>', `Filter by contact status: ${CONTACT_STATUSES.join(' / ')}`)
    .option('--tag <tag>', 'Filter by tag (exact match on one tag)')
    .option(
      '--limit <n>',
      'Results per page (default 100, max 200; larger values are capped by the server)',
      (value) => Number.parseInt(value, 10),
    )
    .option('--offset <n>', 'Pagination offset, starting at 0 (default 0)', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      if (opts.limit != null && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
        throw new Error('--limit must be a positive integer');
      }
      if (opts.offset != null && (!Number.isInteger(opts.offset) || opts.offset < 0)) {
        throw new Error('--offset must be a non-negative integer');
      }
      const res = await (await clientFor(command)).listContacts(opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.contacts?.length) return info('No contacts');
      printTable(['External ID', 'Email', 'Name', 'Status', 'Tags'], res.contacts.map((contact: any) => [
        contact.externalId,
        contact.email,
        contact.name ?? '',
        contact.status,
        (contact.tags ?? []).join(', '),
      ]));
      const offset = res.offset ?? 0;
      const shown = `${offset + 1}-${offset + res.contacts.length}`;
      info(res.total != null ? `${res.total} total, showing ${shown}` : `Showing ${shown}`);
      if (res.hasMore) {
        info(`Next page: --offset ${offset + res.contacts.length}` + (res.limit ? ` --limit ${res.limit}` : ''));
      }
    });

  contacts
    .command('show')
    .description('Show one contact with its attributes, status, and tags')
    .argument('<external-contact-id>')
    .action(async (externalContactId, _opts, command) => {
      const res = await (await clientFor(command)).getWorkflowContact(externalContactId);
      if (getOutputFormat() === 'json') return printJSON(res);
      displayContact(res.contact);
    });

  contacts
    .command('upsert')
    .description('Create or update one contact')
    .argument('<external-contact-id>')
    .requiredOption('--file <path>', 'Contact JSON file; use - to read from stdin')
    .action(async (externalContactId, opts, command) => {
      const res = await (await clientFor(command)).upsertContact(
        externalContactId,
        await readJsonInput(opts.file),
      );
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Contact ${externalContactId} ${res.created ? 'created' : 'updated'}`);
      displayContact(res.contact);
    });

  contacts
    .command('batch')
    .description(`Bulk upsert contacts; input of any size is submitted in order, ${DEFAULT_CONTACT_CHUNK_SIZE} per batch`)
    .requiredOption('--file <path>', 'Contact JSON array or {"contacts": [...]}; use - to read from stdin')
    .option(
      '--chunk-size <n>',
      `Contacts per request (default ${DEFAULT_CONTACT_CHUNK_SIZE}, max ${MAX_CONTACT_CHUNK_SIZE})`,
      (value) => Number.parseInt(value, 10),
    )
    .action(async (opts, command) => {
      const input = await readJsonInput(opts.file) as any;
      const batch = Array.isArray(input) ? input : input?.contacts;
      if (!Array.isArray(batch)) throw new Error('Batch input must be a JSON array or {"contacts": [...]}.');
      if (batch.length === 0) throw new Error('Batch input cannot be empty.');
      const chunkSize = resolveChunkSize(opts.chunkSize);
      const client = await clientFor(command);
      const totals = await syncChunks(
        chunkItems(batch, chunkSize),
        batch.length,
        // index is local to the chunk; add the offset to map it back to the original file
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
      success(`Contact sync finished: ${totals.succeeded} succeeded, ${totals.failed} failed (${totals.chunks} batches)`);
      for (const item of totals.results.filter((result: any) => !result.success)) {
        info(`  #${item.index}: ${item.error}`);
      }
    });

  contacts
    .command('import')
    .description(`Import contacts from CSV; any number of rows is submitted in order with the header, ${DEFAULT_CONTACT_CHUNK_SIZE} rows per batch`)
    .argument('<csv-file>')
    .option(
      '--chunk-size <n>',
      `Rows per request (default ${DEFAULT_CONTACT_CHUNK_SIZE}, max ${MAX_CONTACT_CHUNK_SIZE})`,
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
        // row from the server is chunk-local (the header is row 1); add the offset to get the original file row
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
      success(`CSV import finished: ${totals.succeeded} succeeded, ${totals.failed} failed (${totals.chunks} batches)`);
      for (const item of results.filter((result: any) => !result.success)) {
        info(`  Row ${item.row}: ${item.error}`);
      }
    });

  contacts
    .command('suppress')
    .description('Add a contact to workspace suppression to stop further sends')
    .argument('<external-contact-id>')
    .option('--reason <reason>', 'unsubscribed, hard_bounce, complaint, or manual', 'manual')
    .option('--source <source>', 'Audit source', 'cli')
    .action(async (externalContactId, opts, command) => {
      const res = await (await clientFor(command)).suppressContact(externalContactId, opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Contact ${externalContactId} added to workspace suppression`);
      info(`  Suppression ID: ${res.suppressionId}`);
    });

  contacts
    .command('delete')
    .description('Soft-delete a contact and add it to suppression')
    .argument('<external-contact-id>')
    .action(async (externalContactId, _opts, command) => {
      const res = await (await clientFor(command)).deleteContact(externalContactId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Contact ${externalContactId} soft-deleted and suppressed`);
    });

  contacts
    .command('history')
    .description('Show delivery, campaign, workflow, and transactional email history for a contact')
    .argument('<external-contact-id>')
    .option('--limit <n>', 'Number of results per history type', (value) => Number.parseInt(value, 10))
    .action(async (externalContactId, opts, command) => {
      const res = await (await clientFor(command)).getContactHistory(externalContactId, opts.limit);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`Send history for contact ${externalContactId}`);
      info(`  Delivery ledger: ${res.deliveries?.length ?? 0}`);
      info(`  Campaign deliveries: ${res.campaignDeliveries?.length ?? 0}`);
      info(`  Workflow sends: ${res.workflowSends?.length ?? 0}`);
      info(`  Transactional sends: ${res.transactionalSends?.length ?? 0}`);
      if (res.deliveries?.length) {
        printTable(['Campaign', 'Email', 'Status', 'Subject'], res.deliveries.map((delivery: any) => [
          delivery.campaign_key ?? '-',
          delivery.recipient_email,
          delivery.status,
          delivery.subject,
        ]));
      }
    });

  contacts
    .command('audiences')
    .description('Show the audiences a contact currently belongs to')
    .argument('<external-contact-id>')
    .action(async (externalContactId, _opts, command) => {
      const res = await (await clientFor(command)).getContactAudiences(externalContactId);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.audiences?.length) return info('This contact does not belong to any audience');
      printTable(['Key', 'Name', 'Type'], res.audiences.map((entry: any) => [
        entry.audience.key,
        entry.audience.name,
        entry.membership,
      ]));
    });
}
