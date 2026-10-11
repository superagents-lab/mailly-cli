import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON } from '../output.js';

export function registerStatus(program: Command) {
  program
    .command('status')
    .description('Show the status of a batch send task')
    .argument('<taskId>', 'Batch task ID (from the `mailly send` response)')
    .action(async (taskId: string, _opts, command) => {
      const globalOpts = command.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.emailStatus(taskId);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }

      const status = res?.status ?? res?.task?.status ?? 'unknown';
      const total = res?.totalEmails ?? res?.task?.totalEmails ?? '-';
      const processed = res?.processedEmails ?? res?.task?.processedEmails ?? '-';
      const succeeded = res?.successfulEmails ?? res?.task?.successfulEmails ?? '-';
      const failed = res?.failedEmails ?? res?.task?.failedEmails ?? '-';
      const skipped = res?.skippedEmails ?? res?.task?.skippedEmails ?? 0;

      info(`Task ${c.cyan(taskId)}`);
      info(`  Status: ${c.bold(String(status))}`);
      info(`  Total: ${total}    Processed: ${processed}`);
      info(`  Succeeded: ${c.green(String(succeeded))}    Failed: ${c.red(String(failed))}    Suppressed: ${skipped}`);
    });
}
