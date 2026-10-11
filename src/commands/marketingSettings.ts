import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, success } from '../output.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

export function registerMarketingSettings(program: Command) {
  const settings = program.command('marketing-settings').description('配置 Marketing Footer 品牌信息');

  settings
    .command('show', { isDefault: true })
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).getMarketingSettings();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.settings) return info('尚未配置 Marketing Footer 品牌信息');
      info(`品牌名称: ${res.settings.brandName}`);
      info(`邮寄地址: ${res.settings.postalAddress}`);
    });

  settings
    .command('set')
    .requiredOption('--brand-name <name>', '品牌名称')
    .requiredOption('--postal-address <address>', '有效邮寄地址')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).updateMarketingSettings({
        brandName: opts.brandName,
        postalAddress: opts.postalAddress,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success('Marketing Footer 品牌信息已更新');
    });
}
