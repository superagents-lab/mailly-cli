import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON, success } from '../output.js';

function fmtUnix(seconds: number | null | undefined): string {
  if (!seconds) return '-';
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function readTokenFromStdin(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolvePromise(data.trim()));
    process.stdin.on('error', rejectPromise);
  });
}

async function resolveTokenValue(tokenFlag?: string): Promise<string> {
  if (tokenFlag) return tokenFlag.trim();
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  if (!process.stdin.isTTY) {
    const piped = await readTokenFromStdin();
    if (piped) return piped;
  }
  throw new Error(
    'No token provided. Use --token <token>, set the CLOUDFLARE_API_TOKEN environment variable, or pipe it in ' +
    '(for example `mailly dns set-token < token.txt`).',
  );
}

export function registerDns(program: Command) {
  const dns = program.command('dns').description('Manage DNS provider tokens (enables one-step Cloudflare DNS setup)');

  dns
    .command('status', { isDefault: true })
    .description('Show the status of the saved DNS provider token')
    .action(async (_opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.getCloudflareTokenStatus();

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (res.status.configured) {
        success(`Cloudflare token saved (ends with ${c.cyan(res.status.tokenHint ?? '****')}), updated ${fmtUnix(res.status.updatedAt)}`);
        info('  Once domain ownership is approved, run `mailly domains apply-dns <domain-id>` to write the DNS records in one step.');
      } else {
        info('No Cloudflare token saved.');
        info('  To create one: Cloudflare Dashboard → My Profile → API Tokens → Create Token');
        info('  Permissions: Zone → DNS → Edit (limit Zone Resources to the domains you need), then run `mailly dns set-token`.');
      }
    });

  dns
    .command('set-token')
    .description('Verify and save a Cloudflare API token (can also be read from the CLOUDFLARE_API_TOKEN environment variable)')
    .option('--token <token>', 'Cloudflare API token (prefer the environment variable or a pipe to keep it out of shell history)')
    .action(async (opts: { token?: string }, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const apiToken = await resolveTokenValue(opts.token);
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.setCloudflareToken(apiToken);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || 'Save failed');
      success(res.message || 'Cloudflare token saved');
      info(`  Ends with: ${c.cyan(res.status.tokenHint ?? '****')}`);
      info('  Next: once domain ownership is approved, run `mailly domains apply-dns <domain-id>`.');
    });

  dns
    .command('remove-token')
    .description('Delete the saved Cloudflare token')
    .action(async (_opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.removeCloudflareToken();

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || 'Delete failed');
      success(res.message || 'Cloudflare token deleted');
    });
}
