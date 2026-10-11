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
  const templates = program.command('templates').description('Manage versioned email templates');

  templates
    .command('list', { isDefault: true })
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listEmailTemplates(opts.limit, opts.offset);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.templates?.length) return info('No email templates');
      printTable(['Key', 'Name', 'Status', 'Default locale', 'Type', 'Updated at'], res.templates.map((template: any) => [
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
    .option('--version <n>', 'Show a specific published version', (value) => Number.parseInt(value, 10))
    .action(async (templateKey, opts, command) => {
      const res = await (await clientFor(command)).getEmailTemplate(templateKey);
      if (opts.version != null) {
        const version = res.versions?.find((item: any) => item.version === opts.version);
        if (!version) throw new Error(`Template ${templateKey} has no version ${opts.version}.`);
        if (getOutputFormat() === 'json') return printJSON({ success: true, templateKey, version });
        info(`${templateKey}@${version.version}`);
        info(`  Published at: ${version.publishedAt}`);
        info(`  Default locale: ${version.definition.defaultLocale}`);
        info(`  Type: ${version.definition.emailType}`);
        return;
      }
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${res.template.name} (${res.template.templateKey})`);
      info(`  Status: ${res.template.status}`);
      info(`  Published versions: ${res.versions?.length ?? 0}`);
      info(`  Current version: ${res.versions?.[0]?.version ?? '-'}`);
    });

  templates
    .command('create')
    .requiredOption('--key <template-key>', 'Stable template key')
    .requiredOption('--file <path>', 'Template definition JSON; use - to read from stdin')
    .option('--name <name>', 'Template name (defaults to the key)')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).createEmailTemplate({
        templateKey: opts.key,
        name: opts.name ?? opts.key,
        definition: await readJsonInput(opts.file),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Template ${res.template.templateKey} draft created`);
    });

  templates
    .command('update')
    .argument('<template-key>')
    .requiredOption('--file <path>', 'Template definition JSON; use - to read from stdin')
    .option('--name <name>', 'Also rename')
    .action(async (templateKey, opts, command) => {
      const res = await (await clientFor(command)).updateEmailTemplateDraft(templateKey, {
        name: opts.name,
        definition: await readJsonInput(opts.file),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Template ${templateKey} draft updated`);
    });

  templates
    .command('publish')
    .argument('<template-key>')
    .action(async (templateKey, _opts, command) => {
      const res = await (await clientFor(command)).publishEmailTemplate(templateKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Template ${templateKey}@${res.version.version} published`);
    });

  templates
    .command('render')
    .argument('<template-key>')
    .option('--version <n>', 'Render a specific published version', (value) => Number.parseInt(value, 10))
    .option('--draft', 'Render the current draft')
    .option('--locale <locale>', 'Requested locale; falls back exact -> language -> default')
    .option('--variables <path>', 'Variables JSON; use - to read from stdin')
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
      success(`Template ${templateKey} archived`);
    });

  templates
    .command('test-send')
    .argument('<template-key>')
    .requiredOption('--to <email>', 'Internal test recipient email')
    .option('--version <n>', 'Test a specific published version', (value) => Number.parseInt(value, 10))
    .option('--draft', 'Test the current draft')
    .option('--locale <locale>', 'Requested locale')
    .option('--variables <path>', 'Variables JSON; use - to read from stdin')
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
      success(`Test email for template ${templateKey} submitted to ${opts.to}`);
      if (res.provider_response?.taskId) info(`  Task ID: ${res.provider_response.taskId}`);
    });
}
