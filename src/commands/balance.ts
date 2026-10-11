import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON } from '../output.js';

export function registerBalance(program: Command) {
  program
    .command('balance')
    .description('Show the USD balance of the current API key')
    .action(async (_opts, command) => {
      const globalOpts = command.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.balance();

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      info(`Balance (USD): ${c.green(String(res.balance))}`);
    });
}
