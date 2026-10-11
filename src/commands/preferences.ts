import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, success } from '../output.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

function formatTime(timestamp?: number | null) {
  return timestamp ? new Date(timestamp * 1000).toISOString() : '—';
}

function stateLabel(state: string) {
  if (state === 'subscribed') return 'subscribed';
  if (state === 'unsubscribed') return 'unsubscribed';
  return 'suppressed';
}

export function registerPreferences(program: Command) {
  const preferences = program.command('preferences').description('Check and restore recipient subscription status');

  preferences
    .command('show <email>')
    .description('Show the workspace-level preference, suppression, and latest re-consent record')
    .action(async (email, _opts, command) => {
      const res = await (await clientFor(command)).getPreferenceStatus(email);
      if (getOutputFormat() === 'json') return printJSON(res);
      const status = res.status;
      info(`Email: ${status.email}`);
      info(`Scope: ${status.scope}`);
      info(`Effective state: ${stateLabel(status.state)}`);
      info(`Preference: ${status.preference ? (status.preference.subscribed ? 'subscribed' : 'unsubscribed') : 'subscribed (default)'}`);
      info(`Suppression: ${status.suppression ? `${status.suppression.reason} (${status.suppression.source})` : 'none'}`);
      info(`Can resubscribe without override: ${status.canResubscribe ? 'yes' : 'no'}`);
      info(`Updated at: ${formatTime(status.updatedAt)}`);
      if (status.lastConsent) {
        info(`Latest consent: ${formatTime(status.lastConsent.consentAt)} (${status.lastConsent.consentReference})`);
      }
    });

  preferences
    .command('resubscribe <email>')
    .description('Atomically restore a workspace subscription with explicit re-consent evidence')
    .option('--scope <scope>', 'Subscription scope (V1 supports workspace only)', 'workspace')
    .requiredOption('--source <source>', 'Re-consent source, for example support_ticket or customer_portal')
    .requiredOption('--consent-at <timestamp>', 'Re-consent time (ISO 8601)')
    .requiredOption('--consent-reference <reference>', 'Auditable consent evidence reference, reusable on retry')
    .action(async (email, opts, command) => {
      if (opts.scope !== 'workspace') throw new Error('--scope only supports workspace in V1');
      const res = await (await clientFor(command)).resubscribePreference({
        email,
        scope: 'workspace',
        source: opts.source,
        consentAt: opts.consentAt,
        consentReference: opts.consentReference,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (res.idempotent) {
        success('This re-consent request was already processed; the subscription state is unchanged');
      } else if (res.changed) {
        success('Subscription restored; the unsubscribe suppression and preference were updated atomically');
      } else {
        info('This recipient is already subscribed; nothing to change');
      }
      if (res.auditEventId) info(`Audit event: ${res.auditEventId}`);
    });
}
