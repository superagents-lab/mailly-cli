import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON } from '../output.js';

export function registerStatus(program: Command) {
  program
    .command('status')
    .description('查询批量发送任务状态')
    .argument('<taskId>', '批量任务 ID（来自 `mailly send` 的响应）')
    .action(async (taskId: string, _opts, command) => {
      const globalOpts = command.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.emailStatus(taskId);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }

      const status = res?.status ?? res?.task?.status ?? '未知';
      const total = res?.totalEmails ?? res?.task?.totalEmails ?? '-';
      const processed = res?.processedEmails ?? res?.task?.processedEmails ?? '-';
      const succeeded = res?.successfulEmails ?? res?.task?.successfulEmails ?? '-';
      const failed = res?.failedEmails ?? res?.task?.failedEmails ?? '-';
      const skipped = res?.skippedEmails ?? res?.task?.skippedEmails ?? 0;

      info(`任务 ${c.cyan(taskId)}`);
      info(`  状态: ${c.bold(String(status))}`);
      info(`  总数: ${total}    已处理: ${processed}`);
      info(`  成功: ${c.green(String(succeeded))}    失败: ${c.red(String(failed))}    已抑制: ${skipped}`);
    });
}
