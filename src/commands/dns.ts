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
    '未提供 Token。请使用 --token <token>、设置 CLOUDFLARE_API_TOKEN 环境变量，或通过管道传入 ' +
    '(例如 `mailly dns set-token < token.txt`)。',
  );
}

export function registerDns(program: Command) {
  const dns = program.command('dns').description('DNS 服务商 Token 管理（支持 Cloudflare 一键配 DNS）');

  dns
    .command('status', { isDefault: true })
    .description('查看已保存的 DNS 服务商 Token 状态')
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
        success(`Cloudflare Token 已保存（提示后缀 ${c.cyan(res.status.tokenHint ?? '****')}），更新于 ${fmtUnix(res.status.updatedAt)}`);
        info('  可在域名归属审核通过后运行 `mailly domains apply-dns <domain-id>` 一键写入 DNS 记录。');
      } else {
        info('尚未保存 Cloudflare Token。');
        info('  创建方法: Cloudflare Dashboard → My Profile → API Tokens → Create Token');
        info('  权限: Zone → DNS → Edit（Zone Resources 限定需要的域名）；然后运行 `mailly dns set-token`。');
      }
    });

  dns
    .command('set-token')
    .description('校验并保存 Cloudflare API Token（也可从 CLOUDFLARE_API_TOKEN 环境变量读取）')
    .option('--token <token>', 'Cloudflare API Token（建议改用环境变量或管道传入，避免留在 shell 历史里）')
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
      if (!res.success) throw new Error(res.error || '保存失败');
      success(res.message || 'Cloudflare Token 已保存');
      info(`  提示后缀: ${c.cyan(res.status.tokenHint ?? '****')}`);
      info('  下一步: 域名归属审核通过后运行 `mailly domains apply-dns <domain-id>`。');
    });

  dns
    .command('remove-token')
    .description('删除已保存的 Cloudflare Token')
    .action(async (_opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.removeCloudflareToken();

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || '删除失败');
      success(res.message || 'Cloudflare Token 已删除');
    });
}
