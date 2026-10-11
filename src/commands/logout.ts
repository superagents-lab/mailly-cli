import type { Command } from 'commander';
import { clearConfig, configPath } from '../config.js';
import { getOutputFormat, info, printJSON, success } from '../output.js';

export function registerLogout(program: Command) {
  program
    .command('logout')
    .description('删除本地保存的 API Key')
    .action(async () => {
      const removed = await clearConfig();
      if (getOutputFormat() === 'json') {
        printJSON({ success: true, removed, path: configPath() });
        return;
      }
      if (removed) {
        success(`已删除 ${configPath()}`);
      } else {
        info('未找到本地配置文件，无需删除。');
      }
    });
}
