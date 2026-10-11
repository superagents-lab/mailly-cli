import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, success, warn } from '../output.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

export function registerDeliveryWebhooks(program: Command) {
  const webhooks = program.command('webhooks').description('Configure the signed delivery-event webhook');

  webhooks
    .command('show', { isDefault: true })
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).getDeliveryWebhook();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.webhook) return info('No delivery-event webhook configured');
      info(`URL: ${res.webhook.url}`);
      info(`Status: ${res.webhook.active ? 'active' : 'disabled'}`);
      info(`Events: ${res.webhook.events.join(', ')}`);
    });

  webhooks
    .command('set')
    .requiredOption('--url <url>', 'Public HTTPS callback URL')
    .option('--events <types>', 'Comma-separated event types; subscribes to all by default')
    .option('--signing-secret <secret>', 'Custom signing secret (32-256 characters)')
    .option('--rotate-secret', 'Generate a new signing secret')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).setDeliveryWebhook({
        url: opts.url,
        events: opts.events?.split(',').map((value: string) => value.trim()).filter(Boolean),
        signingSecret: opts.signingSecret,
        rotateSecret: opts.rotateSecret,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Webhook configured: ${res.webhook.url}`);
      if (res.signingSecret) {
        warn('The signing secret is shown only once. Save it now:');
        info(res.signingSecret);
      }
    });

  webhooks
    .command('disable')
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).disableDeliveryWebhook();
      if (getOutputFormat() === 'json') return printJSON(res);
      success(res.disabled ? 'Webhook disabled' : 'No webhook to disable');
    });
}
