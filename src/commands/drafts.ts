import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { printJSON } from '../output.js';
import { readJsonInput } from './jsonInput.js';

async function clientFor(command: Command) {
  let root = command;
  while (root.parent) root = root.parent;
  return new MaillyClient(await resolveAuth(root.opts()));
}
function ccList(value: unknown, key = 'cc'): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${key} must be an array of email addresses`);
  return value as string[];
}
function positiveRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('revision must be a positive integer');
  return revision;
}
async function input(path: string): Promise<Record<string, unknown>> {
  const body = await readJsonInput(path);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Draft input must be a JSON object');
  const result = body as Record<string, unknown>;
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 512 * 1024) throw new Error('text must be a non-empty body of at most 512K characters');
  return result;
}
export function registerDrafts(program: Command) {
  const drafts = program.command('drafts').description('Standalone email drafts: the host drafts, a human reviews, then it sends');
  drafts.command('list').option('--thread-id <id>', 'Filter by email thread').action(async (opts, command) => {
    printJSON(await (await clientFor(command)).listMailDrafts(opts.threadId));
  });
  drafts.command('show <draft-id>').action(async (id, _opts, command) => {
    printJSON(await (await clientFor(command)).getMailDraft(id));
  });
  drafts.command('save').requiredOption('--input <path>', 'JSON file (anchor_email_id / text / idempotency_key, optional cc array and reply_all); use - to read from stdin')
    .action(async (opts, command) => {
      const body = await input(opts.input);
      for (const key of ['anchor_email_id', 'idempotency_key']) if (typeof body[key] !== 'string' || !body[key]) throw new Error(`${key} must be a non-empty string`);
      if (body.reply_all !== undefined && typeof body.reply_all !== 'boolean') throw new Error('reply_all must be true or false');
      const cc = ccList(body.cc);
      printJSON(await (await clientFor(command)).saveMailDraft({
        anchor_email_id: body.anchor_email_id as string, text: body.text as string, idempotency_key: body.idempotency_key as string,
        ...(cc ? { cc } : {}), ...(body.reply_all ? { reply_all: true } : {}),
      }));
    });
  drafts.command('update <draft-id>').requiredOption('--input <path>', 'JSON: text / revision, optional cc array (replaces the Cc; omit to keep it)')
    .action(async (id, opts, command) => {
      const body = await input(opts.input);
      const cc = ccList(body.cc);
      printJSON(await (await clientFor(command)).updateMailDraft(id, { text: body.text as string, revision: positiveRevision(body.revision), ...(cc ? { cc } : {}) }));
    });
  drafts.command('approve <draft-id>').requiredOption('--input <path>', 'Reviewed exact text / revision')
    .requiredOption('--yes', 'Confirm approving and sending this body')
    .action(async (id, opts, command) => {
      const body = await input(opts.input);
      printJSON(await (await clientFor(command)).approveMailDraft(id, { text: body.text as string, revision: positiveRevision(body.revision) }));
    });
  drafts.command('discard <draft-id>').requiredOption('--revision <n>', 'Current draft revision')
    .action(async (id, opts, command) => printJSON(await (await clientFor(command)).discardMailDraft(id, positiveRevision(opts.revision))));
}
