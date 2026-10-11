import type { Command } from 'commander';
import { clearConfig, configPath } from '../config.js';
import { getOutputFormat, info, printJSON, success } from '../output.js';

export function registerLogout(program: Command) {
  program
    .command('logout')
    .description('Delete the locally saved API key')
    .action(async () => {
      const removed = await clearConfig();
      if (getOutputFormat() === 'json') {
        printJSON({ success: true, removed, path: configPath() });
        return;
      }
      if (removed) {
        success(`Deleted ${configPath()}`);
      } else {
        info('No local config file found; nothing to delete.');
      }
    });
}
