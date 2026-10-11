import { promises as fs } from 'node:fs';
import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON, success, warn } from '../output.js';
import { readStdin } from '../stdin.js';
import { readJsonInput } from './jsonInput.js';
import { loadEmailAttachments } from '../attachments.js';

interface SendOptions {
  to?: string[];
  recipient?: string[];
  subject?: string;
  html?: string;
  htmlFile?: string;
  text?: string;
  textFile?: string;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  cc?: string;
  bcc?: string;
  provider?: string;
  emailType?: 'transactional' | 'lifecycle' | 'marketing';
  marketing?: boolean;
  topic?: string;
  dryRun?: boolean;
  campaignKey?: string;
  campaignName?: string;
  testSend?: boolean;
  frequencyCapDays?: number;
  frequencyCapMax?: number;
  topicExclusionDays?: number;
  recipientReason?: string;
  templateKey?: string;
  templateVersion?: number;
  fromTemplate?: string;
  templateDraft?: boolean;
  locale?: string;
  var?: string[];
  variables?: string;
  audienceDefinitionFile?: string;
  sourceApp?: string;
  utmFile?: string;
  businessGoal?: string;
  scheduleAt?: string;
  audience?: string[];
  excludeAudience?: string[];
  attachment?: string[];
  inline?: string[];
  messageId?: string;
  inReplyTo?: string;
  reference?: string[];
}

function collect(value: string, prev: string[]) {
  return [...prev, ...value.split(',').map((s) => s.trim()).filter(Boolean)];
}

function collectOne(value: string, prev: string[]) {
  return [...prev, value];
}

interface TemplateRender {
  subject: string;
  html?: string;
  text?: string;
  emailType?: 'transactional' | 'lifecycle' | 'marketing';
  from: { email: string; name?: string };
  topic?: string;
  recipientReason?: string;
  frequencyCap?: { days: number; max: number };
  version?: number | 'draft';
}

/** Merges the --variables file with --var overrides; --var values are always strings. */
async function readSendVariables(
  opts: SendOptions,
): Promise<Record<string, string | number | boolean> | undefined> {
  const values: Record<string, string | number | boolean> = {};
  if (opts.variables) {
    const parsed = await readJsonInput(opts.variables);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('--variables must be a JSON object');
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error(`--variables ${name} must be a string, number, or boolean`);
      }
      values[name] = value as string | number | boolean;
    }
  }
  for (const entry of opts.var ?? []) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new Error('--var must use the format <name=value>');
    values[entry.slice(0, separator).trim()] = entry.slice(separator + 1);
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

export function registerSend(program: Command) {
  program
    .command('send')
    .description('Send email — multiple recipients and real campaigns are queued automatically')
    .option('-t, --to <email>', 'Recipient email (repeatable or comma-separated)', collect, [] as string[])
    .option('--recipient <external-id=email>', 'Recipient with your external_id (repeatable)', collectOne, [] as string[])
    .option('-s, --subject <subject>', 'Subject')
    .option('--html <html>', 'HTML body')
    .option('--html-file <path>', 'Read the HTML body from a file (mutually exclusive with --html)')
    .option('--text <text>', 'Plain-text body (sent as multipart/alternative when combined with --html)')
    .option('--text-file <path>', 'Read the plain-text body from a file (mutually exclusive with --text)')
    .option('-f, --from-email <email>', 'Sender email (required)')
    .option('-n, --from-name <name>', 'Sender display name')
    .option('--reply-to <email>', 'Reply-To address')
    .option('--cc <email>', 'Cc (batch sends only)')
    .option('--bcc <email>', 'Bcc (batch sends only)')
    .option('--provider <provider>', 'Email provider (chosen by the backend by default)')
    .option('--email-type <type>', 'Email type: transactional, lifecycle, or marketing (default transactional)')
    .option('--marketing', 'Shortcut for marketing sends (same as --email-type marketing)')
    .option('--campaign-key <key>', 'Campaign idempotency key; required in marketing mode')
    .option('--campaign-name <name>', 'Campaign display name (used on first creation)')
    .option('--audience <key>', 'Audience key to include (repeatable)', collect, [] as string[])
    .option('--exclude-audience <key>', 'Audience key to exclude (repeatable)', collect, [] as string[])
    .option('--test-send', 'Send a test email without claiming real campaign recipient records')
    .option('--frequency-cap-days <days>', 'Frequency cap window in days', (value) => Number.parseInt(value, 10))
    .option('--frequency-cap-max <count>', 'Maximum marketing emails within the frequency cap window', (value) => Number.parseInt(value, 10))
    .option('--topic-exclusion-days <days>', 'Days to exclude recipients already sent the same topic', (value) => Number.parseInt(value, 10))
    .option('--recipient-reason <reason>', 'Short reason for receiving, shown in the marketing footer')
    .option('--template-key <key>', 'Record the published template key used to produce the body (recorded only, not rendered)')
    .option('--template-version <version>', 'Template version; with --from-template, selects the version to render', (value) => Number.parseInt(value, 10))
    .option('--from-template <key>', 'Render the body from a published template, then send (use with --var/--variables)')
    .option('--template-draft', 'Render the template draft instead of a published version (requires --from-template)')
    .option('--locale <locale>', 'Template locale; falls back exact -> language -> default')
    .option('--var <name=value>', 'Template variable (repeatable; values are strings)', collectOne, [] as string[])
    .option('--variables <path>', 'Variables JSON file; use - to read from stdin')
    .option('--audience-definition-file <path>', 'Audience definition JSON file')
    .option('--source-app <app>', 'Calling app identifier')
    .option('--utm-file <path>', 'UTM parameters JSON file')
    .option('--business-goal <goal>', 'Campaign business goal')
    .option('--schedule-at <time>', 'Scheduled send time (ISO 8601 or Unix seconds)')
    .option('--topic <topic>', 'Preference topic for lifecycle/marketing email')
    .option('--dry-run', 'Preview eligible/suppressed recipients only; no sending, no charge')
    .option('--attachment <path>', 'Attach a local file (repeatable; up to 10 files / 6MB total)', collectOne, [] as string[])
    .option(
      '--inline <content-id=path>',
      'Add an inline image referenced by HTML cid: (repeatable); campaign sends allow up to 10 images, 1MB total',
      collectOne,
      [] as string[],
    )
    .option('--message-id <message-id>', 'Set the RFC Message-ID of this email')
    .option('--in-reply-to <message-id>', 'Mark this email as a reply to the given Message-ID')
    .option('--reference <message-id>', 'Append a References Message-ID (repeatable, up to 50)', collectOne, [] as string[])
    .action(async (opts: SendOptions, command) => {
      const globalOpts = command.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });

      const identifiedRecipients = (opts.recipient ?? []).map((value) => {
        const separator = value.lastIndexOf('=');
        if (separator <= 0 || separator === value.length - 1) {
          throw new Error('--recipient must use the format <external-id=email>');
        }
        return {
          externalId: value.slice(0, separator).trim(),
          email: value.slice(separator + 1).trim(),
        };
      });
      const directRecipients: Array<string | { email: string; externalId: string }> = [
        ...identifiedRecipients,
        ...(opts.to ?? []),
      ];
      const hasAudience = Boolean(opts.audience?.length || opts.excludeAudience?.length);
      if (directRecipients.length === 0 && !hasAudience && !opts.campaignKey?.trim()) {
        throw new Error('Use --to, --recipient, --audience, or a --campaign-key that already has a frozen audience');
      }
      const variables = await readSendVariables(opts);
      const client = new MaillyClient(auth);
      let rendered: TemplateRender | undefined;
      if (opts.fromTemplate) {
        if (opts.html || opts.htmlFile || opts.text || opts.textFile) {
          throw new Error('--from-template takes the body from the template; do not also pass --html/--text options');
        }
        if (opts.templateKey) throw new Error('--from-template records the template key automatically; do not also pass --template-key');
        if (opts.templateDraft && opts.templateVersion != null) {
          throw new Error('--template-draft and --template-version cannot be used together');
        }
        const result = await client.renderEmailTemplate(opts.fromTemplate, {
          version: opts.templateVersion,
          draft: opts.templateDraft,
          locale: opts.locale,
          variables: variables ?? {},
        });
        rendered = { ...result.rendered, version: result.version };
      } else if (opts.templateDraft || opts.locale) {
        throw new Error('--template-draft and --locale require --from-template');
      } else if ((opts.templateKey == null) !== (opts.templateVersion == null)) {
        throw new Error('--template-key and --template-version must be given together');
      }

      const subject = opts.subject ?? rendered?.subject;
      const fromEmail = opts.fromEmail ?? rendered?.from.email;
      const fromName = opts.fromName ?? rendered?.from.name;
      if (!subject) throw new Error('Missing subject. Use --subject <subject>');
      if (!fromEmail) throw new Error('Missing sender email. Use --from-email <email>');
      if (opts.emailType && !['transactional', 'lifecycle', 'marketing'].includes(opts.emailType)) {
        throw new Error('--email-type must be transactional, lifecycle, or marketing');
      }
      if (opts.marketing && opts.emailType === 'lifecycle') {
        throw new Error('--marketing cannot be combined with --email-type lifecycle');
      }
      const emailType = opts.marketing
        ? 'marketing'
        : opts.emailType ?? rendered?.emailType ?? 'transactional';
      const topic = opts.topic ?? rendered?.topic;
      const recipientReason = opts.recipientReason ?? rendered?.recipientReason;
      const frequencyCapDays = opts.frequencyCapDays ?? rendered?.frequencyCap?.days;
      const frequencyCapMax = opts.frequencyCapMax ?? rendered?.frequencyCap?.max;
      if (emailType === 'marketing' && !opts.campaignKey?.trim()) {
        throw new Error('Marketing mode requires --campaign-key');
      }
      if (opts.testSend && !opts.campaignKey?.trim()) {
        throw new Error('--test-send requires --campaign-key');
      }
      if (opts.testSend && directRecipients.length === 0) {
        throw new Error('--test-send requires explicit internal --to recipients');
      }
      if (opts.testSend && opts.dryRun) {
        throw new Error('--test-send cannot be combined with --dry-run');
      }
      if (hasAudience && !opts.campaignKey?.trim()) {
        throw new Error('--audience/--exclude-audience require --campaign-key to freeze the audience');
      }
      if (hasAudience && opts.testSend) {
        throw new Error('Campaign test sends must use explicit internal --to recipients, not audiences');
      }
      if ((frequencyCapDays == null) !== (frequencyCapMax == null)) {
        throw new Error('--frequency-cap-days and --frequency-cap-max must be given together');
      }
      if (opts.topicExclusionDays != null && (
        !Number.isInteger(opts.topicExclusionDays) || opts.topicExclusionDays <= 0 || !topic?.trim()
      )) throw new Error('--topic-exclusion-days must be a positive integer and requires --topic');
      if (
        frequencyCapDays != null &&
        (!Number.isInteger(frequencyCapDays) || frequencyCapDays <= 0 ||
          !Number.isInteger(frequencyCapMax) || frequencyCapMax! <= 0)
      ) {
        throw new Error('frequency cap values must be positive integers');
      }
      if (recipientReason && (recipientReason.length > 300 || /[\r\n]/.test(recipientReason))) {
        throw new Error('--recipient-reason must be at most 300 characters without line breaks');
      }
      if (opts.html && opts.htmlFile) {
        throw new Error('--html and --html-file cannot be used together');
      }
      if (opts.text && opts.textFile) {
        throw new Error('--text and --text-file cannot be used together');
      }
      // Regular attachment bytes travel with each queue message, so they are limited to single-recipient direct sends;
      // campaign cid: inline images are stored once per campaign, so bulk sends support them.
      const hasPlainAttachments = Boolean(opts.attachment?.length);
      const hasInline = Boolean(opts.inline?.length);
      const hasThreadHeaders = Boolean(opts.messageId || opts.inReplyTo || opts.reference?.length);
      const isDirectSingleSend = directRecipients.length === 1 &&
        identifiedRecipients.length === 0 && !hasAudience && !opts.campaignKey;
      if ((hasPlainAttachments || hasThreadHeaders) && !isDirectSingleSend) {
        throw new Error('Attachments and threading options only work for direct, non-campaign sends to a single --to');
      }
      if (hasInline && !isDirectSingleSend && !opts.campaignKey?.trim()) {
        throw new Error('--inline only works for direct sends to a single --to or campaign sends with --campaign-key');
      }
      if ((opts.reference?.length ?? 0) > 50) throw new Error('--reference can be repeated at most 50 times');
      for (const [flag, value] of [
        ['--message-id', opts.messageId],
        ['--in-reply-to', opts.inReplyTo],
        ...((opts.reference ?? []).map((reference) => ['--reference', reference])),
      ] as Array<[string, string | undefined]>) {
        if (value && (value.length > 998 || /[\r\n]/.test(value))) {
          throw new Error(`${flag} must be a Message-ID of at most 998 characters without line breaks`);
        }
      }

      let html = rendered?.html ?? opts.html;
      if (opts.htmlFile) {
        html = await fs.readFile(opts.htmlFile, 'utf8');
      }
      let text = rendered?.text ?? opts.text;
      if (opts.textFile) {
        text = await fs.readFile(opts.textFile, 'utf8');
      }
      // With no body options and a non-TTY stdin, treat stdin as HTML
      if (!html && !text && !process.stdin.isTTY) {
        html = await readStdin();
      }
      if (!html && !text) {
        throw new Error(
          'Missing body. Use --html / --html-file / --text / --text-file or pipe it via stdin',
        );
      }
      if (opts.inline?.length && !html) throw new Error('--inline requires an HTML body');
      const attachments = await loadEmailAttachments(opts.attachment, opts.inline);

      const audienceDefinition = opts.audienceDefinitionFile
        ? await readJsonInput(opts.audienceDefinitionFile)
        : undefined;
      const utmInput = opts.utmFile ? await readJsonInput(opts.utmFile) : undefined;
      if (utmInput != null && (
        typeof utmInput !== 'object' || Array.isArray(utmInput) ||
        Object.values(utmInput).some((value) => typeof value !== 'string')
      )) throw new Error('--utm-file must contain a JSON object whose values are all strings');
      let scheduledAt: number | undefined;
      if (opts.scheduleAt) {
        scheduledAt = /^\d+$/.test(opts.scheduleAt)
          ? Number.parseInt(opts.scheduleAt, 10)
          : Math.floor(Date.parse(opts.scheduleAt) / 1000);
        if (!Number.isInteger(scheduledAt) || scheduledAt <= Math.floor(Date.now() / 1000)) {
          throw new Error('--schedule-at must be a future ISO 8601 time or Unix seconds');
        }
        if (!opts.campaignKey?.trim() || opts.testSend || opts.dryRun) {
          throw new Error('--schedule-at only works for real campaigns and cannot be combined with --test-send or --dry-run');
        }
      }

      const isBulk = directRecipients.length > 1 || hasAudience;
      const isQueuedCampaign = Boolean(opts.campaignKey?.trim() && !opts.testSend && !opts.dryRun);
      const payload = {
        ...(directRecipients.length > 0 ? {
          to: identifiedRecipients.length > 0 || directRecipients.length > 1
            ? directRecipients
            : directRecipients[0] as string,
        } : {}),
        subject,
        ...(html ? { html } : {}),
        ...(text ? { text } : {}),
        // The template was already rendered on the server; inline variables only apply to sends with their own body
        ...(variables && !rendered ? { variables } : {}),
        fromEmail,
        fromName,
        replyTo: opts.replyTo,
        cc: opts.cc,
        bcc: opts.bcc,
        provider: opts.provider,
        emailType,
        campaignKey: opts.campaignKey?.trim(),
        campaignName: opts.campaignName?.trim(),
        testSend: opts.testSend,
        frequencyCapDays,
        frequencyCapMax,
        topicExclusionDays: opts.topicExclusionDays,
        recipientReason: recipientReason?.trim(),
        ...(rendered && typeof rendered.version === 'number'
          ? { templateKey: opts.fromTemplate!.trim(), templateVersion: rendered.version }
          : { templateKey: opts.templateKey?.trim(), templateVersion: opts.templateVersion }),
        audienceDefinition,
        sourceApp: opts.sourceApp?.trim(),
        utm: utmInput as Record<string, string> | undefined,
        businessGoal: opts.businessGoal?.trim(),
        scheduledAt,
        topic,
        dryRun: opts.dryRun,
        ...(opts.messageId ? { messageId: opts.messageId.trim() } : {}),
        ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo.trim() } : {}),
        ...(opts.reference?.length
          ? { references: opts.reference.map((reference) => reference.trim()) }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(hasAudience ? {
          audience: {
            include: opts.audience ?? [],
            exclude: opts.excludeAudience ?? [],
          },
        } : {}),
      };

      const res = await client.sendEmail(payload);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }

      if (!res.success) {
        throw new Error(res.error || 'Send failed');
      }

      const recipientCount = res.eligibleCount ?? directRecipients.length;
      if (opts.dryRun) {
        success('Dry run complete');
        info(`  Input: ${res.inputCount ?? 0}    After dedupe: ${res.deduplicatedCount ?? 0}`);
        info(`  Duplicates: ${res.duplicateCount ?? 0}    Invalid: ${res.invalidCount ?? 0}`);
        info(`  Unsubscribed: ${res.unsubscribedCount ?? 0}    Already sent: ${res.alreadySentCount ?? 0}`);
        info(`  Already claimed by campaign: ${res.campaignClaimedCount ?? 0}`);
        info(`  Excluded by frequency cap: ${res.frequencyCappedCount ?? 0}`);
        info(`  Excluded by topic window: ${res.topicExcludedCount ?? 0}`);
        info(`  Eligible: ${res.eligibleCount ?? 0}    Email units: ${res.requiredEmailUnits ?? 0}`);
        return;
      }
      success(res.message || (isBulk || isQueuedCampaign
        ? `Send task queued (${recipientCount} recipients)`
        : 'Email sent'));
      if (res.scheduled && res.scheduledAt) {
        info(`Scheduled for: ${c.cyan(new Date(res.scheduledAt * 1000).toISOString())}`);
        if (res.dispatchId) info(`Dispatch ID: ${c.cyan(res.dispatchId)}`);
        return;
      }

      const taskId =
        res.provider_response?.taskId ||
        res.provider_response?.provider_response?.taskId ||
        res.provider_response?.batchId;
      if ((isBulk || isQueuedCampaign) && taskId) {
        info(`Task ID: ${c.cyan(String(taskId))}`);
        info(c.dim(`Check batch progress with \`mailly status ${taskId}\``));
      }
      if ((isBulk || isQueuedCampaign) && !taskId) {
        warn('No taskId in the response; check `mailly logs` for the record');
      }
    });
}
