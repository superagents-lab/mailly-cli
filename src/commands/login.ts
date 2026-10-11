import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { writeConfig, configPath, maskKey, DEFAULT_BASE_URL } from '../config.js';
import { MaillyClient, cliAuthInit, cliAuthPoll } from '../client.js';
import { c, getOutputFormat, info, printJSON, success, warn } from '../output.js';
import { openBrowser } from '../browser.js';

interface LoginOptions {
  baseUrl?: string;
  verify?: boolean;
  browser?: boolean;
  webUrl?: string;
  resume?: string;
}

const DEFAULT_WEB_URL = 'https://mailly.site';

function deriveWebUrl(apiBaseUrl: string): string {
  // For local dev, default to http://localhost:3000.
  if (apiBaseUrl.startsWith('http://localhost') || apiBaseUrl.startsWith('http://127.')) {
    return 'http://localhost:3000';
  }
  return DEFAULT_WEB_URL;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerLogin(program: Command) {
  program
    .command('login')
    .description('登录到 Mailly。默认通过浏览器授权（device-code flow）；也可直接粘贴 API Key。')
    .argument('[api-key]', 'API Key（直接粘贴，跳过浏览器授权）')
    .option('--base-url <url>', '设置 API Base URL（覆盖默认值）')
    .option('--no-verify', '保存 API Key 时跳过余额校验（仅 api-key 模式有效）')
    .option('--no-browser', '不自动打开浏览器，只打印授权 URL')
    .option('--web-url <url>', '指定 Web 端 URL（默认根据 base-url 自动推断）')
    .option('--resume <device-token>', '续办此前由 --json 发起的浏览器授权')
    .action(async (apiKeyArg, opts: LoginOptions, command) => {
      const globalOpts = command.parent!.opts() as { apiKey?: string; baseUrl?: string };
      // login 是「重新登录」语义，永远从生产 URL 起步，除非用户显式覆盖。
      // 不读 ~/.mailly/config.json 里的 baseUrl —— 那是上次某次登录的残留，
      // 用户可能正在切环境（例如本地测过之后回到生产）。
      const baseUrl =
        opts.baseUrl ||
        globalOpts.baseUrl ||
        process.env.MAILLY_BASE_URL ||
        DEFAULT_BASE_URL;

      const explicitApiKey = apiKeyArg || globalOpts.apiKey;
      if (explicitApiKey && opts.resume) throw new Error('API Key 登录不能与 --resume 同时使用');
      if (explicitApiKey) {
        await loginWithApiKey({
          apiKey: explicitApiKey,
          baseUrl,
          verify: opts.verify !== false,
        });
        return;
      }

      if (opts.resume) {
        if (!/^[a-f0-9]{64}$/i.test(opts.resume)) throw new Error('--resume 必须是有效的 device token');
        const result = await cliAuthPoll(baseUrl, opts.resume);
        if (result.status === 'pending') {
          if (getOutputFormat() === 'json') {
            printJSON({ success: true, status: 'pending', deviceToken: opts.resume });
          } else {
            info('网页授权尚未完成，请完成后重试同一个 --resume 命令。');
          }
          return;
        }
        if (result.status === 'expired') throw new Error('授权请求已过期，请重新运行 mailly login');
        await finishDeviceLogin(result, baseUrl);
        return;
      }

      // Device-code flow
      const webUrl = (opts.webUrl || deriveWebUrl(baseUrl)).replace(/\/+$/, '');
      const deviceToken = randomBytes(32).toString('hex');

      const init = await cliAuthInit(baseUrl, deviceToken);
      const authUrl = `${webUrl}/cli-auth?token=${encodeURIComponent(deviceToken)}`;

      if (getOutputFormat() === 'json') {
        // In JSON mode, never block on browser/poll — emit the URL and exit so callers
        // can drive the flow themselves.
        printJSON({
          success: true,
          status: 'pending',
          deviceToken,
          authUrl,
          baseUrl,
          expiresIn: init.expiresIn,
          interval: init.interval,
          hint: '在浏览器中完成授权后，调用 mailly login --base-url <baseUrl> --resume <deviceToken> 完成登录',
        });
        return;
      }

      info(c.bold('一次性授权码已生成。'));
      info(`请在浏览器中打开下方链接完成授权（${init.expiresIn} 秒内有效）：`);
      info('');
      info(`  ${c.cyan(authUrl)}`);
      info('');

      let opened = false;
      if (opts.browser !== false) {
        opened = openBrowser(authUrl);
      }
      if (opened) {
        info(c.dim('已尝试在系统默认浏览器中打开。'));
      } else if (opts.browser !== false) {
        warn('未能自动打开浏览器，请手动复制上面的链接。');
      }

      info(c.dim('等待网页授权…（按 Ctrl+C 取消）'));

      const pollIntervalMs = Math.max(1, init.interval) * 1000;
      const deadline = Date.now() + init.expiresIn * 1000;

      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        const result = await cliAuthPoll(baseUrl, deviceToken);
        if (result.status === 'pending') continue;
        if (result.status === 'expired') {
          throw new Error('授权请求已过期，请重新运行 mailly login');
        }
        // approved
        await finishDeviceLogin(result, baseUrl);
        return;
      }

      throw new Error('授权请求已过期，请重新运行 mailly login');
    });
}

async function finishDeviceLogin(
  result: { status: 'approved'; apiKey: string; email: string },
  baseUrl: string,
) {
  await writeConfig({ apiKey: result.apiKey, baseUrl });
  if (getOutputFormat() === 'json') {
    printJSON({
      success: true,
      status: 'approved',
      email: result.email,
      apiKey: maskKey(result.apiKey),
      baseUrl,
    });
    return;
  }
  success(`已登录为 ${c.cyan(result.email)}`);
  info(`  API Key: ${c.cyan(maskKey(result.apiKey))}（已保存到 ${configPath()}）`);
  info(`  Base URL: ${c.cyan(baseUrl)}`);
  try {
    const client = new MaillyClient({ apiKey: result.apiKey, baseUrl, source: 'flag' });
    const bal = await client.balance();
    info(`  当前余额 (USD): ${c.green(String(bal.balance))}`);
  } catch {
    // 登录成功不应因余额查询失败而回滚。
  }
}

async function loginWithApiKey(opts: { apiKey: string; baseUrl: string; verify: boolean }) {
  let balance: number | undefined;
  if (opts.verify) {
    try {
      const client = new MaillyClient({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        source: 'flag',
      });
      const res = await client.balance();
      balance = res.balance;
    } catch (err: any) {
      warn(`API Key 校验失败：${err.message}`);
      throw new Error('API Key 无效或网络异常。如需跳过校验请加 --no-verify。');
    }
  }

  await writeConfig({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

  if (getOutputFormat() === 'json') {
    printJSON({
      success: true,
      apiKey: maskKey(opts.apiKey),
      baseUrl: opts.baseUrl,
      balance,
    });
    return;
  }
  success(`已保存 API Key 到 ${configPath()}`);
  info(`  API Key: ${c.cyan(maskKey(opts.apiKey))}`);
  info(`  Base URL: ${c.cyan(opts.baseUrl)}`);
  if (balance != null) info(`  当前余额 (USD): ${c.green(String(balance))}`);
}
