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
function positiveRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('revision 必须是正整数');
  return revision;
}
async function input(path: string): Promise<Record<string, unknown>> {
  const body = await readJsonInput(path);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('草稿输入必须是 JSON 对象');
  const result = body as Record<string, unknown>;
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 512 * 1024) throw new Error('text 必须是非空正文且不超过 512K 字符');
  return result;
}
export function registerDrafts(program: Command) {
  const drafts = program.command('drafts').description('独立邮件草稿：宿主起草，人工审核后发送');
  drafts.command('list').option('--thread-id <id>', '按邮件会话过滤').action(async (opts, command) => {
    printJSON(await (await clientFor(command)).listMailDrafts(opts.threadId));
  });
  drafts.command('show <draft-id>').action(async (id, _opts, command) => {
    printJSON(await (await clientFor(command)).getMailDraft(id));
  });
  drafts.command('save').requiredOption('--input <path>', 'JSON 文件；- 从 stdin 读取')
    .action(async (opts, command) => {
      const body = await input(opts.input);
      for (const key of ['anchor_email_id', 'idempotency_key']) if (typeof body[key] !== 'string' || !body[key]) throw new Error(`${key} 必须是非空字符串`);
      printJSON(await (await clientFor(command)).saveMailDraft({ anchor_email_id: body.anchor_email_id as string, text: body.text as string, idempotency_key: body.idempotency_key as string }));
    });
  drafts.command('update <draft-id>').requiredOption('--input <path>', 'JSON: text / revision')
    .action(async (id, opts, command) => {
      const body = await input(opts.input);
      printJSON(await (await clientFor(command)).updateMailDraft(id, { text: body.text as string, revision: positiveRevision(body.revision) }));
    });
  drafts.command('approve <draft-id>').requiredOption('--input <path>', '审核过的精确 text / revision')
    .requiredOption('--yes', '确认批准并发送此正文')
    .action(async (id, opts, command) => {
      const body = await input(opts.input);
      printJSON(await (await clientFor(command)).approveMailDraft(id, { text: body.text as string, revision: positiveRevision(body.revision) }));
    });
  drafts.command('discard <draft-id>').requiredOption('--revision <n>', '当前草稿版本')
    .action(async (id, opts, command) => printJSON(await (await clientFor(command)).discardMailDraft(id, positiveRevision(opts.revision))));
}
