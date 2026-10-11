import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, success } from '../output.js';

export function registerCode(program: Command) {
  const code = program.command('code').description('验证码服务');

  code
    .command('send')
    .description('向指定邮箱发送 6 位验证码（5 分钟有效）')
    .argument('<email>', '收件邮箱')
    .action(async (email: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.sendCode(email);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      success(res.message || `验证码已发送到 ${email}`);
      info('验证码 5 分钟内有效，使用 `mailly code verify <email> <code>` 校验');
    });

  code
    .command('verify')
    .description('校验邮箱验证码')
    .argument('<email>', '收件邮箱')
    .argument('<code>', '6 位验证码')
    .action(async (email: string, codeStr: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.verifyCode(email, codeStr);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      success(res.message || '验证成功');
    });
}
