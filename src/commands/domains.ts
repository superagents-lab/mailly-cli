import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON, printTable, success } from '../output.js';

function fmtUnix(seconds: number): string {
  if (!seconds) return '-';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function registerDomains(program: Command) {
  const domains = program.command('domains').description('Manage sending and receiving on custom domains');

  domains
    .command('list', { isDefault: true })
    .description('List domain ownership, SES sending, and MX receiving status for this account')
    .action(async (_opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.listSenderDomains();

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.domains.length) {
        info('No sender domains available');
        return;
      }
      const rows = res.domains.map((d) => [
        d.domain,
        d.ownershipStatus ?? (d.status === 'verified' ? 'verified' : d.status),
        d.outboundStatus ?? (
          d.status === 'verified' ? 'verified' : d.status === 'rejected' ? 'rejected' : 'not_configured'
        ),
        d.inboundStatus ?? 'not_configured',
        d.isDefault ? 'yes' : 'no',
        fmtUnix(d.createdAt),
      ]);
      printTable(['Domain', 'Ownership', 'Sending', 'Receiving', 'Default', 'Created at'], rows);
    });

  domains
    .command('add')
    .description('Submit a custom domain for ownership review (then set up sending and/or receiving)')
    .argument('<domain>', 'Domain, for example mail.example.com')
    .action(async (domain: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.addSenderDomain(domain);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) {
        throw new Error(res.error || 'Submission failed');
      }
      success(res.message || 'Submitted');
      if (res.domain) {
        info(`  Domain ID: ${c.cyan(res.domain.id)}`);
        info(`  Status: ${res.domain.status}`);
        info('  Next: wait for the domain ownership review. Once approved, set up sending and/or receiving:');
        info('    One step (Cloudflare): after mailly dns set-token, run '
          + `mailly domains apply-dns ${res.domain.id}`);
        info(`    Sending, manually: mailly domains setup-outbound ${res.domain.id}`);
        info('    Receiving, manually: add an MX record in Cloudflare or your actual DNS provider (target smtp.mailly.site, priority 10)');
        info(`            then run mailly domains verify-inbound ${res.domain.id}`);
        info(`  After receiving is verified: mailly inbox addresses create --domain ${domain.trim().toLowerCase()} --prefix <prefix>`);
        info('  Receiving only does not need SES; sending needs the CNAME records returned by SES added to DNS. Changing the root domain MX affects all mail received on that domain.');
      }
    });

  domains
    .command('verify-inbound')
    .description('Check whether the custom domain MX points to Mailly')
    .argument('<domain-id>', 'Domain ID from mailly domains list')
    .action(async (domainId: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.verifyInboundDomain(domainId);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || 'MX check failed');
      if (res.ready) {
        success(res.message || 'Inbound MX verified');
        return;
      }
      info(res.message || 'MX is not ready yet');
      if (res.expectedMx) {
        info(`  MX ${res.expectedMx.priority} ${res.expectedMx.exchange}`);
        info('  Add it in Cloudflare (DNS → Records → Add record) or your actual DNS provider; for the root domain the Name is usually @.');
        info('  If the root domain already has a business email MX, use a separate subdomain so existing mail is not taken over.');
      }
      if (res.error) info(`  ${res.error}`);
    });

  domains
    .command('setup-outbound')
    .description('Create an SES sending identity for an approved domain and return the DNS records to add')
    .argument('<domain-id>', 'Domain ID from mailly domains list')
    .action(async (domainId: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.setupOutboundDomain(domainId);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || 'Failed to enable sending');
      if (res.ready) {
        success(res.message || 'Sending enabled');
        return;
      }
      info(res.message || 'Add the SES sending DNS records');
      printOutboundDns(res.outboundDnsRecords);
      info(`  After saving, run: mailly domains verify-outbound ${domainId}`);
    });

  domains
    .command('verify-outbound')
    .description('Check whether SES has verified the domain DKIM sending records')
    .argument('<domain-id>', 'Domain ID from mailly domains list')
    .action(async (domainId: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.verifyOutboundDomain(domainId);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || 'Sending check failed');
      if (res.ready) {
        success(res.message || 'Sending enabled');
        return;
      }
      info(res.message || 'SES has not verified the sending records yet');
      printOutboundDns(res.outboundDnsRecords);
      if (res.error) info(`  ${res.error}`);
    });

  domains
    .command('apply-dns')
    .description('Write the DNS records this domain needs using the saved Cloudflare token (idempotent, safe to rerun)')
    .argument('<domain-id>', 'Domain ID from mailly domains list')
    .option('--scope <scope>', 'Scope: all (default), outbound (sending only), inbound (receiving only)')
    .option('--token <token>', 'Use this Cloudflare token once (not saved on the server)')
    .action(async (domainId: string, opts: { scope?: string; token?: string }, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const scope = opts.scope && ['all', 'outbound', 'inbound'].includes(opts.scope)
        ? (opts.scope as 'all' | 'outbound' | 'inbound')
        : 'all';
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.applyDomainDns(domainId, { scope, ...(opts.token ? { apiToken: opts.token } : {}) });

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success && !res.results?.length) throw new Error(res.error || 'DNS setup failed');

      const outcomeLabel: Record<string, string> = {
        created: 'created',
        existing: 'exists',
        conflict: 'conflict',
        failed: 'failed',
      };
      printTable(
        ['Record', 'Result', 'Details'],
        res.results.map((record) => [
          record.priority != null
            ? `${record.type} ${record.priority} ${record.name}`
            : `${record.type} ${record.name}`,
          outcomeLabel[record.outcome] ?? record.outcome,
          record.error ?? record.content,
        ]),
      );
      if (res.success) {
        success(res.message);
      } else {
        info(res.message);
        info('  Conflicting records were left unchanged. Review them on the Cloudflare DNS page first (for example, use a subdomain if the root domain already has another MX).');
      }
      info(`  DNS takes a few minutes to propagate. Then run: mailly domains verify-outbound ${domainId} / mailly domains verify-inbound ${domainId}`);
    });
}

function printOutboundDns(records?: Array<{
  type: string;
  host: string;
  value: string;
  priority?: number;
  purpose: string;
  required: boolean;
}>) {
  if (!records?.length) return;
  info('  Add these in Cloudflare (DNS → Records → Add record) or your actual DNS provider (CNAME records must not be proxied):');
  printTable(
    ['Type', 'Name / Host', 'Value', 'Purpose'],
    records.map((record) => [
      record.priority != null ? `${record.type} ${record.priority}` : record.type,
      record.host,
      record.value,
      record.required ? `${record.purpose} (required)` : `${record.purpose} (recommended)`,
    ]),
  );
}
