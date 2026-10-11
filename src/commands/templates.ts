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

export function registerTemplates(program: Command) {
  const templates = program.command('templates').description('版本化邮件模板管理');

  templates
    .command('list', { isDefault: true })
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listEmailTemplates(opts.limit, opts.offset);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.templates?.length) return info('暂无邮件模板');
      printTable(['Key', '名称', '状态', '默认语言', '类型', '更新时间'], res.templates.map((template: any) => [
        template.templateKey,
        template.name,
        template.status,
        template.draftDefinition.defaultLocale,
        template.draftDefinition.emailType,
        template.updatedAt,
      ]));
    });

  templates
    .command('show')
    .argument('<template-key>')
    .option('--version <n>', '查看指定已发布版本', (value) => Number.parseInt(value, 10))
    .action(async (templateKey, opts, command) => {
      const res = await (await clientFor(command)).getEmailTemplate(templateKey);
      if (opts.version != null) {
        const version = res.versions?.find((item: any) => item.version === opts.version);
        if (!version) throw new Error(`模板 ${templateKey} 不存在版本 ${opts.version}。`);
        if (getOutputFormat() === 'json') return printJSON({ success: true, templateKey, version });
        info(`${templateKey}@${version.version}`);
        info(`  发布时间: ${version.publishedAt}`);
        info(`  默认语言: ${version.definition.defaultLocale}`);
        info(`  类型: ${version.definition.emailType}`);
        return;
      }
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${res.template.name} (${res.template.templateKey})`);
      info(`  状态: ${res.template.status}`);
      info(`  已发布版本: ${res.versions?.length ?? 0}`);
      info(`  当前版本: ${res.versions?.[0]?.version ?? '-'}`);
    });

  templates
    .command('create')
    .requiredOption('--key <template-key>', '稳定的 Template Key')
    .requiredOption('--file <path>', '模板 definition JSON；使用 - 从 stdin 读取')
    .option('--name <name>', '模板名称；默认使用 key')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).createEmailTemplate({
        templateKey: opts.key,
        name: opts.name ?? opts.key,
        definition: await readJsonInput(opts.file),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`模板 ${res.template.templateKey} 草稿已创建`);
    });

  templates
    .command('update')
    .argument('<template-key>')
    .requiredOption('--file <path>', '模板 definition JSON；使用 - 从 stdin 读取')
    .option('--name <name>', '同时修改名称')
    .action(async (templateKey, opts, command) => {
      const res = await (await clientFor(command)).updateEmailTemplateDraft(templateKey, {
        name: opts.name,
        definition: await readJsonInput(opts.file),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`模板 ${templateKey} 草稿已更新`);
    });

  templates
    .command('publish')
    .argument('<template-key>')
    .action(async (templateKey, _opts, command) => {
      const res = await (await clientFor(command)).publishEmailTemplate(templateKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`模板 ${templateKey}@${res.version.version} 已发布`);
    });

  templates
    .command('render')
    .argument('<template-key>')
    .option('--version <n>', '渲染指定已发布版本', (value) => Number.parseInt(value, 10))
    .option('--draft', '渲染当前草稿')
    .option('--locale <locale>', '请求语言；按 exact -> language -> default 回退')
    .option('--variables <path>', 'Variables JSON；使用 - 从 stdin 读取')
    .action(async (templateKey, opts, command) => {
      const variables = opts.variables ? await readJsonInput(opts.variables) : {};
      const res = await (await clientFor(command)).renderEmailTemplate(templateKey, {
        version: opts.version,
        draft: opts.draft,
        locale: opts.locale,
        variables,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${templateKey}@${res.version}`);
      info(`  Locale: ${res.rendered.locale}`);
      info(`  From: ${res.rendered.from.name ? `${res.rendered.from.name} <${res.rendered.from.email}>` : res.rendered.from.email}`);
      info(`  Subject: ${res.rendered.subject}`);
      info('');
      info(res.rendered.text);
    });

  templates
    .command('archive')
    .argument('<template-key>')
    .action(async (templateKey, _opts, command) => {
      const res = await (await clientFor(command)).archiveEmailTemplate(templateKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`模板 ${templateKey} 已归档`);
    });

  templates
    .command('test-send')
    .argument('<template-key>')
    .requiredOption('--to <email>', '内部测试收件邮箱')
    .option('--version <n>', '测试指定已发布版本', (value) => Number.parseInt(value, 10))
    .option('--draft', '测试当前草稿')
    .option('--locale <locale>', '请求语言')
    .option('--variables <path>', 'Variables JSON；使用 - 从 stdin 读取')
    .action(async (templateKey, opts, command) => {
      const variables = opts.variables ? await readJsonInput(opts.variables) : {};
      const res = await (await clientFor(command)).testSendEmailTemplate(templateKey, {
        to: opts.to,
        version: opts.version,
        draft: opts.draft,
        locale: opts.locale,
        variables,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`模板 ${templateKey} 的测试邮件已提交给 ${opts.to}`);
      if (res.provider_response?.taskId) info(`  Task ID: ${res.provider_response.taskId}`);
    });
}
