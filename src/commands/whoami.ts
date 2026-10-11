import type { Command } from 'commander';
import { resolveAuth, maskKey } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON } from '../output.js';

export function registerWhoami(program: Command) {
  program
    .command('whoami')
    .description('显示当前登录信息（脱敏 API Key、Base URL、余额）')
    .action(async (_opts, command) => {
      const globalOpts = command.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.balance();

      if (getOutputFormat() === 'json') {
        printJSON({
          success: true,
          apiKey: maskKey(auth.apiKey),
          baseUrl: auth.baseUrl,
          source: auth.source,
          balance: res.balance,
        });
        return;
      }
      info(`API Key: ${c.cyan(maskKey(auth.apiKey))} ${c.dim(`(来自 ${auth.source})`)}`);
      info(`Base URL: ${c.cyan(auth.baseUrl)}`);
      info(`余额 (USD): ${c.green(String(res.balance))}`);
    });
}
