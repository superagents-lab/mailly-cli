import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, success } from '../output.js';

export function registerCode(program: Command) {
  const code = program.command('code').description('Email verification codes');

  code
    .command('send')
    .description('Send a 6-digit verification code to an email address (valid for 5 minutes)')
    .argument('<email>', 'Recipient email address')
    .action(async (email: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.sendCode(email);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      success(res.message || `Verification code sent to ${email}`);
      info('The code is valid for 5 minutes. Check it with `mailly code verify <email> <code>`');
    });

  code
    .command('verify')
    .description('Verify an email verification code')
    .argument('<email>', 'Recipient email address')
    .argument('<code>', '6-digit verification code')
    .action(async (email: string, codeStr: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.verifyCode(email, codeStr);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      success(res.message || 'Verified');
    });
}
