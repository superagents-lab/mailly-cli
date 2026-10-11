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
  const settings = program.command('marketing-settings').description('Configure the marketing footer brand details');

  settings
    .command('show', { isDefault: true })
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).getMarketingSettings();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.settings) return info('Marketing footer brand details are not configured');
      info(`Brand name: ${res.settings.brandName}`);
      info(`Postal address: ${res.settings.postalAddress}`);
    });

  settings
    .command('set')
    .requiredOption('--brand-name <name>', 'Brand name')
    .requiredOption('--postal-address <address>', 'Valid postal address')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).updateMarketingSettings({
        brandName: opts.brandName,
        postalAddress: opts.postalAddress,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success('Marketing footer brand details updated');
    });
}
