import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON, printTable, success } from '../output.js';
import { readJsonInput } from './jsonInput.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

function date(seconds: number | null | undefined): string {
  return seconds ? new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-';
}

export function registerCampaigns(program: Command) {
  const campaigns = program.command('campaigns').description('Query and control campaigns');

  campaigns
    .command('create')
    .requiredOption('--file <path>', 'Campaign JSON (may include audience.include/exclude); use - to read from stdin')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).createCampaign(await readJsonInput(opts.file));
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Campaign ${res.campaign.campaignKey} created`);
      if (res.audienceSnapshot) {
        info(`  Audience snapshot: ${res.audienceSnapshot.resolvedRecipientCount} recipients`);
      }
    });

  campaigns
    .command('list', { isDefault: true })
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listCampaigns(opts.limit, opts.offset);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.campaigns?.length) return info('No campaigns');
      printTable(['Key', 'Status', 'Type', 'Recipients', 'Updated at'], res.campaigns.map((campaign: any) => [
        campaign.campaign_key,
        campaign.status,
        campaign.email_type,
        String(campaign.recipient_count ?? 0),
        date(campaign.updated_at),
      ]));
    });

  campaigns
    .command('show')
    .argument('<campaign-key>')
    .action(async (campaignKey, _opts, command) => {
      const res = await (await clientFor(command)).getCampaign(campaignKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`Campaign ${c.cyan(campaignKey)}`);
      info(`  Status: ${res.campaign.status}`);
      info(`  Type: ${res.campaign.emailType}`);
      info(`  From: ${res.campaign.senderEmail}`);
      info(`  Subject: ${res.campaign.subject}`);
      info(`  Recipient status: ${JSON.stringify(res.recipientCounts ?? {})}`);
      info(`  Delivery results: ${JSON.stringify(res.deliveryCounts ?? {})}`);
      info(`  Report: ${JSON.stringify(res.report ?? {})}`);
      if (res.audienceSnapshot) {
        info(`  Audience snapshot: ${res.audienceSnapshot.resolvedRecipientCount} (frozen at ${res.audienceSnapshot.createdAt})`);
      }
    });

  campaigns
    .command('audience')
    .argument('<campaign-key>')
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (campaignKey, opts, command) => {
      const res = await (await clientFor(command)).getCampaignAudience(campaignKey, opts.limit, opts.offset);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`Campaign ${campaignKey} frozen audience: ${res.snapshot.resolvedRecipientCount}`);
      if (res.members?.length) {
        printTable(['External ID', 'Email', 'Name'], res.members.map((member: any) => [
          member.externalId ?? '-',
          member.email,
          member.name ?? '',
        ]));
      }
    });

  for (const action of ['pause', 'resume', 'cancel', 'complete'] as const) {
    campaigns
      .command(action)
      .argument('<campaign-key>')
      .action(async (campaignKey, _opts, command) => {
        const res = await (await clientFor(command)).campaignAction(campaignKey, action);
        if (getOutputFormat() === 'json') return printJSON(res);
        success(`Campaign ${campaignKey} ${({ pause: 'paused', resume: 'resumed', cancel: 'canceled', complete: 'completed' } as const)[action]}`);
      });
  }

  campaigns
    .command('update-content')
    .description('Edit the subject and body of a paused campaign; undelivered recipients get the new version after resume')
    .argument('<campaign-key>')
    .option('--subject <subject>', 'New subject')
    .option('--html <html>', 'New HTML body')
    .option('--html-file <path>', 'Read the HTML body from a file (mutually exclusive with --html)')
    .option('--text <text>', 'New plain-text body')
    .option('--text-file <path>', 'Read the plain-text body from a file (mutually exclusive with --text)')
    .option('--drop-html', 'Remove the HTML body and keep only plain text')
    .option('--drop-text', 'Remove the plain-text body and keep only HTML')
    .action(async (campaignKey, opts, command) => {
      if (opts.html && opts.htmlFile) throw new Error('--html and --html-file cannot be used together');
      if (opts.text && opts.textFile) throw new Error('--text and --text-file cannot be used together');
      if (opts.dropHtml && (opts.html || opts.htmlFile)) throw new Error('--drop-html cannot be combined with --html/--html-file');
      if (opts.dropText && (opts.text || opts.textFile)) throw new Error('--drop-text cannot be combined with --text/--text-file');
      const content: { subject?: string; html?: string | null; text?: string | null } = {};
      if (opts.subject) content.subject = opts.subject;
      if (opts.dropHtml) content.html = null;
      else if (opts.html) content.html = opts.html;
      else if (opts.htmlFile) content.html = await fs.readFile(opts.htmlFile, 'utf8');
      if (opts.dropText) content.text = null;
      else if (opts.text) content.text = opts.text;
      else if (opts.textFile) content.text = await fs.readFile(opts.textFile, 'utf8');
      if (Object.keys(content).length === 0) {
        throw new Error('Provide at least one of --subject, --html/--html-file, or --text/--text-file');
      }
      const res = await (await clientFor(command)).updateCampaignContent(campaignKey, content);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.changed) return info(`Campaign ${campaignKey} content is unchanged`);
      success(`Campaign ${campaignKey} content updated (revision ${res.campaign?.contentRevision})`);
      info(`  Pending recipients: ${res.deferredRecipientCount ?? 0}; they get the new content after resume`);
    });

  campaigns
    .command('resend-unsent')
    .description('Requeue failed recipients and add frozen-audience members that were never sent')
    .argument('<campaign-key>')
    .option('--dry-run', 'Only list recipients to resend; no sending, no charge')
    .action(async (campaignKey, opts, command) => {
      const res = await (await clientFor(command)).resendUnsentCampaignRecipients(campaignKey, {
        dryRun: Boolean(opts.dryRun),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (opts.dryRun) {
        info(`Campaign ${c.cyan(campaignKey)} to resend: ${res.unsentCount ?? 0}`);
        if (res.unsentRecipients?.length) {
          printTable(['Email', 'Failure reason', 'Attempts'], res.unsentRecipients.map((recipient: any) => [
            recipient.email,
            recipient.reason ?? '-',
            String(recipient.attempt ?? 1),
          ]));
        }
        if (res.audienceFrozen) info('  This campaign has a frozen audience; the resend also includes members that were never claimed');
        return;
      }
      if (!res.eligibleCount) return info(res.message || 'No recipients to resend');
      success(`Campaign ${campaignKey} resent to ${res.eligibleCount} recipients`);
      info(`  Failed, pending resend: ${res.unsentCount ?? 0}    Email units used: ${res.requiredEmailUnits ?? res.eligibleCount}`);
    });

  campaigns
    .command('history')
    .argument('<email>')
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (email, opts, command) => {
      const res = await (await clientFor(command)).getContactCampaignHistory(email, opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.history?.length) return info('No campaign send history');
      printTable(['Campaign', 'Subject', 'Status', 'Updated at'], res.history.map((entry: any) => [
        entry.campaign_key,
        entry.subject,
        entry.recipient_status,
        date(entry.recipient_updated_at),
      ]));
    });

  campaigns
    .command('recipients')
    .argument('<campaign-key>')
    .option('--status <status>', 'Filter by recipient status')
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (campaignKey, opts, command) => {
      const res = await (await clientFor(command)).listCampaignRecipients(campaignKey, opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.recipients?.length) return info('No recipient records');
      printTable(['Email', 'External ID', 'Send status', 'Delivery result', 'Reason', 'Updated at'], res.recipients.map((recipient: any) => [
        recipient.recipient_email,
        recipient.external_contact_id ?? '',
        recipient.status,
        recipient.delivery_status ?? '',
        recipient.status_reason ?? '',
        date(recipient.updated_at),
      ]));
    });

  campaigns
    .command('export')
    .argument('<campaign-key>')
    .argument('[output]')
    .action(async (campaignKey, output, _opts, command) => {
      const { filename, csv } = await (await clientFor(command)).downloadCampaignRecipientsCSV(campaignKey);
      const target = resolvePath(output || filename);
      await fs.writeFile(target, csv, 'utf8');
      if (getOutputFormat() === 'json') {
        return printJSON({ success: true, path: target, bytes: Buffer.byteLength(csv, 'utf8') });
      }
      success(`Saved campaign recipient results to ${target}`);
    });
}
