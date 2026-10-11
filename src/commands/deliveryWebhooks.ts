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
  const webhooks = program.command('webhooks').description('配置签名投递事件 Webhook');

  webhooks
    .command('show', { isDefault: true })
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).getDeliveryWebhook();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.webhook) return info('尚未配置投递事件 Webhook');
      info(`URL: ${res.webhook.url}`);
      info(`状态: ${res.webhook.active ? 'active' : 'disabled'}`);
      info(`事件: ${res.webhook.events.join(', ')}`);
    });

  webhooks
    .command('set')
    .requiredOption('--url <url>', '公开 HTTPS 回调地址')
    .option('--events <types>', '逗号分隔事件类型；默认订阅全部')
    .option('--signing-secret <secret>', '自定义 32-256 字符签名密钥')
    .option('--rotate-secret', '生成新的签名密钥')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).setDeliveryWebhook({
        url: opts.url,
        events: opts.events?.split(',').map((value: string) => value.trim()).filter(Boolean),
        signingSecret: opts.signingSecret,
        rotateSecret: opts.rotateSecret,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Webhook 已配置: ${res.webhook.url}`);
      if (res.signingSecret) {
        warn('签名密钥只在本次返回，请立即保存：');
        info(res.signingSecret);
      }
    });

  webhooks
    .command('disable')
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).disableDeliveryWebhook();
      if (getOutputFormat() === 'json') return printJSON(res);
      success(res.disabled ? 'Webhook 已停用' : '没有可停用的 Webhook');
    });
}
