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
    .description('Log in to Mailly. Authorizes in the browser by default (device-code flow); you can also paste an API key.')
    .argument('[api-key]', 'API key (paste it to skip browser authorization)')
    .option('--base-url <url>', 'Set the API base URL (overrides the default)')
    .option('--no-verify', 'Skip the balance check when saving an API key (api-key mode only)')
    .option('--no-browser', 'Do not open a browser; only print the authorization URL')
    .option('--web-url <url>', 'Web app URL (inferred from base-url by default)')
    .option('--resume <device-token>', 'Resume a browser authorization started earlier with --json')
    .action(async (apiKeyArg, opts: LoginOptions, command) => {
      const globalOpts = command.parent!.opts() as { apiKey?: string; baseUrl?: string };
      // login means "log in again", so it always starts from the production URL unless explicitly overridden.
      // Do not read baseUrl from ~/.mailly/config.json: it is left over from a previous login,
      // and the user may be switching environments (for example back to production after local testing).
      const baseUrl =
        opts.baseUrl ||
        globalOpts.baseUrl ||
        process.env.MAILLY_BASE_URL ||
        DEFAULT_BASE_URL;

      const explicitApiKey = apiKeyArg || globalOpts.apiKey;
      if (explicitApiKey && opts.resume) throw new Error('API key login cannot be combined with --resume');
      if (explicitApiKey) {
        await loginWithApiKey({
          apiKey: explicitApiKey,
          baseUrl,
          verify: opts.verify !== false,
        });
        return;
      }

      if (opts.resume) {
        if (!/^[a-f0-9]{64}$/i.test(opts.resume)) throw new Error('--resume must be a valid device token');
        const result = await cliAuthPoll(baseUrl, opts.resume);
        if (result.status === 'pending') {
          if (getOutputFormat() === 'json') {
            printJSON({ success: true, status: 'pending', deviceToken: opts.resume });
          } else {
            info('Browser authorization is not complete yet. Finish it, then rerun the same --resume command.');
          }
          return;
        }
        if (result.status === 'expired') throw new Error('The authorization request expired. Run mailly login again');
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
          hint: 'After authorizing in the browser, run mailly login --base-url <baseUrl> --resume <deviceToken> to finish logging in',
        });
        return;
      }

      info(c.bold('One-time authorization code created.'));
      info(`Open the link below in your browser to authorize (valid for ${init.expiresIn} seconds):`);
      info('');
      info(`  ${c.cyan(authUrl)}`);
      info('');

      let opened = false;
      if (opts.browser !== false) {
        opened = openBrowser(authUrl);
      }
      if (opened) {
        info(c.dim('Tried to open it in your default browser.'));
      } else if (opts.browser !== false) {
        warn('Could not open a browser. Copy the link above manually.');
      }

      info(c.dim('Waiting for browser authorization… (press Ctrl+C to cancel)'));

      const pollIntervalMs = Math.max(1, init.interval) * 1000;
      const deadline = Date.now() + init.expiresIn * 1000;

      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        const result = await cliAuthPoll(baseUrl, deviceToken);
        if (result.status === 'pending') continue;
        if (result.status === 'expired') {
          throw new Error('The authorization request expired. Run mailly login again');
        }
        // approved
        await finishDeviceLogin(result, baseUrl);
        return;
      }

      throw new Error('The authorization request expired. Run mailly login again');
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
  success(`Logged in as ${c.cyan(result.email)}`);
  info(`  API Key: ${c.cyan(maskKey(result.apiKey))} (saved to ${configPath()})`);
  info(`  Base URL: ${c.cyan(baseUrl)}`);
  try {
    const client = new MaillyClient({ apiKey: result.apiKey, baseUrl, source: 'flag' });
    const bal = await client.balance();
    info(`  Balance (USD): ${c.green(String(bal.balance))}`);
  } catch {
    // A failed balance lookup must not roll back a successful login.
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
      warn(`API key check failed: ${err.message}`);
      throw new Error('The API key is invalid or the network failed. Add --no-verify to skip the check.');
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
  success(`Saved API key to ${configPath()}`);
  info(`  API Key: ${c.cyan(maskKey(opts.apiKey))}`);
  info(`  Base URL: ${c.cyan(opts.baseUrl)}`);
  if (balance != null) info(`  Balance (USD): ${c.green(String(balance))}`);
}
