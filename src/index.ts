import { Command } from 'commander';
import { fail, setOutputFormat } from './output.js';
import { ApiError } from './client.js';
import { registerLogin } from './commands/login.js';
import { registerLogout } from './commands/logout.js';
import { registerWhoami } from './commands/whoami.js';
import { registerBalance } from './commands/balance.js';
import { registerSend } from './commands/send.js';
import { registerStatus } from './commands/status.js';
import { registerCode } from './commands/code.js';
import { registerLogs } from './commands/logs.js';
import { registerDomains } from './commands/domains.js';
import { registerDns } from './commands/dns.js';
import { registerCampaigns } from './commands/campaigns.js';
import { registerMarketingSettings } from './commands/marketingSettings.js';
import { registerEvents } from './commands/events.js';
import { registerWorkflows } from './commands/workflows.js';
import { registerTemplates } from './commands/templates.js';
import { registerDeliveryEvents } from './commands/deliveryEvents.js';
import { registerDeliveryWebhooks } from './commands/deliveryWebhooks.js';
import { registerContacts } from './commands/contacts.js';
import { registerAudiences } from './commands/audiences.js';
import { registerPreferences } from './commands/preferences.js';
import { registerInbox } from './commands/inbox.js';
import { registerOutbox } from './commands/outbox.js';
import { registerAgents } from './commands/agents.js';
import { registerDrafts } from './commands/drafts.js';

const VERSION = '0.2.1';

export function createProgram() {
  const program = new Command();
  // Configure before registering subcommands so Commander copies the override
  // into every nested command instead of calling process.exit() during parsing.
  program.exitOverride();

  program
    .name('mailly')
    .description('Mailly CLI — 发送邮件、验证码、管理域名和收件箱')
    .version(VERSION, '-v, --version', '显示版本号')
    .option('--api-key <key>', '使用指定的 API Key（覆盖配置文件和环境变量）')
    .option('--base-url <url>', '使用指定的 API Base URL（默认 https://api.mailly.site）')
    .option('--json', '以 JSON 格式输出（适合脚本和 Agent 调用）')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts() as { json?: boolean };
      if (opts.json) setOutputFormat('json');
    });

  registerLogin(program);
  registerLogout(program);
  registerWhoami(program);
  registerBalance(program);
  registerSend(program);
  registerStatus(program);
  registerCode(program);
  registerLogs(program);
  registerDomains(program);
  registerDns(program);
  registerInbox(program);
  registerOutbox(program);
  registerAgents(program);
  registerDrafts(program);
  registerCampaigns(program);
  registerMarketingSettings(program);
  registerPreferences(program);
  registerEvents(program);
  registerWorkflows(program);
  registerTemplates(program);
  registerDeliveryEvents(program);
  registerDeliveryWebhooks(program);
  registerContacts(program);
  registerAudiences(program);

  return program;
}

export async function run(argv: string[]) {
  const program = createProgram();
  const jsonRequested = argv.includes('--json');

  // Commander validates required options before preAction hooks run. Detect JSON
  // mode up front so parse-time failures keep the same machine-readable contract.
  if (jsonRequested) {
    setOutputFormat('json');
    program.configureOutput({ writeErr: () => {} });
  }

  try {
    await program.parseAsync(argv);
  } catch (err: any) {
    // commander throws CommanderError for things like --help / --version / unknown command
    if (err && err.code && typeof err.code === 'string' && err.code.startsWith('commander.')) {
      const exitCode = typeof err.exitCode === 'number' ? err.exitCode : 1;
      if (exitCode === 0) return;
      if (jsonRequested) return fail(err.message || '命令参数无效');
      // Pretty mode has already received Commander's normal stderr output.
      process.exitCode = exitCode;
      return;
    }
    if (err instanceof ApiError) {
      return fail(`API 错误 (${err.status}): ${err.message}`);
    }
    return fail(err?.message || String(err));
  }
}
