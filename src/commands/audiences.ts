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
  info(`匹配联系人: ${res.count ?? 0}`);
  const explanations = res.audience?.explanation ?? res.audiences?.flatMap((entry: any) => [
    `${entry.role} ${entry.key} (${entry.matchedCount})`,
    ...entry.explanation.map((line: string) => `  ${line}`),
  ]) ?? [];
  for (const line of explanations) info(`  ${line}`);
  if (res.sample?.length) {
    printTable(['External ID', '邮箱', '名称'], res.sample.map((contact: any) => [
      contact.externalId ?? '-',
      contact.email,
      contact.name ?? '',
    ]));
  }
}

export function registerAudiences(program: Command) {
  const audiences = program.command('audiences').description('静态用户集、动态分群、预览与样本');

  audiences
    .command('list', { isDefault: true })
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listAudiences(opts.limit, opts.offset);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.audiences?.length) return info('暂无用户集');
      printTable(['Key', '名称', '类型', '静态成员'], res.audiences.map((audience: any) => [
        audience.key,
        audience.name,
        audience.type,
        audience.memberCount == null ? '-' : String(audience.memberCount),
      ]));
    });

  audiences
    .command('create')
    .requiredOption('--file <path>', 'Audience JSON 定义；使用 - 从 stdin 读取')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).createAudience(await readJsonInput(opts.file));
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`用户集 ${res.audience.key} 已创建`);
    });

  audiences
    .command('show')
    .argument('<audience-key>')
    .action(async (audienceKey, _opts, command) => {
      const res = await (await clientFor(command)).getAudience(audienceKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${res.audience.name} (${res.audience.key})`);
      info(`  类型: ${res.audience.type}`);
      info(`  条件: ${(res.audience.explanation ?? []).join(' ')}`);
    });

  audiences
    .command('update')
    .argument('<audience-key>')
    .requiredOption('--file <path>', '更新 JSON；使用 - 从 stdin 读取')
    .action(async (audienceKey, opts, command) => {
      const res = await (await clientFor(command)).updateAudience(audienceKey, await readJsonInput(opts.file));
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`用户集 ${res.audience.key} 已更新`);
    });

  audiences
    .command('preview')
    .argument('<audience-key>')
    .option('--sample-limit <n>', '样本条数', (value) => Number.parseInt(value, 10))
    .action(async (audienceKey, opts, command) => {
      const res = await (await clientFor(command)).previewAudience(audienceKey, opts.sampleLimit);
      if (getOutputFormat() === 'json') return printJSON(res);
      printPreview(res);
    });

  audiences
    .command('resolve')
    .requiredOption('--file <path>', 'include/exclude 选择 JSON；使用 - 从 stdin 读取')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).previewAudienceSelection(await readJsonInput(opts.file));
      if (getOutputFormat() === 'json') return printJSON(res);
      printPreview(res);
    });

  audiences
    .command('members')
    .argument('<audience-key>')
    .requiredOption('--file <path>', 'External Contact ID JSON 数组；使用 - 从 stdin 读取')
    .option('--replace', '替换完整静态成员列表；默认追加')
    .action(async (audienceKey, opts, command) => {
      const input = await readJsonInput(opts.file);
      if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) {
        throw new Error('成员文件必须是 External Contact ID 字符串数组。');
      }
      const res = await (await clientFor(command)).updateAudienceMembers(
        audienceKey,
        input as string[],
        opts.replace ? 'replace' : 'add',
      );
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`静态用户集 ${audienceKey} 当前有 ${res.memberCount} 个成员`);
    });

  audiences
    .command('remove-member')
    .argument('<audience-key>')
    .argument('<external-contact-id>')
    .action(async (audienceKey, externalContactId, _opts, command) => {
      const res = await (await clientFor(command)).removeAudienceMember(audienceKey, externalContactId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`已从 ${audienceKey} 移除 ${externalContactId}`);
    });

  audiences
    .command('delete')
    .argument('<audience-key>')
    .action(async (audienceKey, _opts, command) => {
      const res = await (await clientFor(command)).deleteAudience(audienceKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`用户集 ${audienceKey} 已删除；既有 Campaign snapshot 不受影响`);
    });
}
