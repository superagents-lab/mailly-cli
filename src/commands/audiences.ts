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

function printPreview(res: any) {
  info(`Matching contacts: ${res.count ?? 0}`);
  const explanations = res.audience?.explanation ?? res.audiences?.flatMap((entry: any) => [
    `${entry.role} ${entry.key} (${entry.matchedCount})`,
    ...entry.explanation.map((line: string) => `  ${line}`),
  ]) ?? [];
  for (const line of explanations) info(`  ${line}`);
  if (res.sample?.length) {
    printTable(['External ID', 'Email', 'Name'], res.sample.map((contact: any) => [
      contact.externalId ?? '-',
      contact.email,
      contact.name ?? '',
    ]));
  }
}

export function registerAudiences(program: Command) {
  const audiences = program.command('audiences').description('Static audiences, dynamic segments, previews, and samples');

  audiences
    .command('list', { isDefault: true })
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listAudiences(opts.limit, opts.offset);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.audiences?.length) return info('No audiences');
      printTable(['Key', 'Name', 'Type', 'Static members'], res.audiences.map((audience: any) => [
        audience.key,
        audience.name,
        audience.type,
        audience.memberCount == null ? '-' : String(audience.memberCount),
      ]));
    });

  audiences
    .command('create')
    .requiredOption('--file <path>', 'Audience JSON definition; use - to read from stdin')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).createAudience(await readJsonInput(opts.file));
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Audience ${res.audience.key} created`);
    });

  audiences
    .command('show')
    .argument('<audience-key>')
    .action(async (audienceKey, _opts, command) => {
      const res = await (await clientFor(command)).getAudience(audienceKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${res.audience.name} (${res.audience.key})`);
      info(`  Type: ${res.audience.type}`);
      info(`  Conditions: ${(res.audience.explanation ?? []).join(' ')}`);
    });

  audiences
    .command('update')
    .argument('<audience-key>')
    .requiredOption('--file <path>', 'Update JSON; use - to read from stdin')
    .action(async (audienceKey, opts, command) => {
      const res = await (await clientFor(command)).updateAudience(audienceKey, await readJsonInput(opts.file));
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Audience ${res.audience.key} updated`);
    });

  audiences
    .command('preview')
    .argument('<audience-key>')
    .option('--sample-limit <n>', 'Sample size', (value) => Number.parseInt(value, 10))
    .action(async (audienceKey, opts, command) => {
      const res = await (await clientFor(command)).previewAudience(audienceKey, opts.sampleLimit);
      if (getOutputFormat() === 'json') return printJSON(res);
      printPreview(res);
    });

  audiences
    .command('resolve')
    .requiredOption('--file <path>', 'include/exclude selection JSON; use - to read from stdin')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).previewAudienceSelection(await readJsonInput(opts.file));
      if (getOutputFormat() === 'json') return printJSON(res);
      printPreview(res);
    });

  audiences
    .command('members')
    .argument('<audience-key>')
    .requiredOption('--file <path>', 'JSON array of external contact IDs; use - to read from stdin')
    .option('--replace', 'Replace the full static member list (appends by default)')
    .action(async (audienceKey, opts, command) => {
      const input = await readJsonInput(opts.file);
      if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) {
        throw new Error('The members file must be an array of external contact ID strings.');
      }
      const res = await (await clientFor(command)).updateAudienceMembers(
        audienceKey,
        input as string[],
        opts.replace ? 'replace' : 'add',
      );
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Static audience ${audienceKey} now has ${res.memberCount} members`);
    });

  audiences
    .command('remove-member')
    .argument('<audience-key>')
    .argument('<external-contact-id>')
    .action(async (audienceKey, externalContactId, _opts, command) => {
      const res = await (await clientFor(command)).removeAudienceMember(audienceKey, externalContactId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Removed ${externalContactId} from ${audienceKey}`);
    });

  audiences
    .command('delete')
    .argument('<audience-key>')
    .action(async (audienceKey, _opts, command) => {
      const res = await (await clientFor(command)).deleteAudience(audienceKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Audience ${audienceKey} deleted; existing campaign snapshots are not affected`);
    });
}
