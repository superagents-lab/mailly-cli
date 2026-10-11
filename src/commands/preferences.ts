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
  if (state === 'subscribed') return '已订阅';
  if (state === 'unsubscribed') return '已退订';
  return '受抑制';
}

export function registerPreferences(program: Command) {
  const preferences = program.command('preferences').description('查询和恢复收件人订阅状态');

  preferences
    .command('show <email>')
    .description('查询 Workspace 级 preference、suppression 与最近重新同意记录')
    .action(async (email, _opts, command) => {
      const res = await (await clientFor(command)).getPreferenceStatus(email);
      if (getOutputFormat() === 'json') return printJSON(res);
      const status = res.status;
      info(`邮箱: ${status.email}`);
      info(`范围: ${status.scope}`);
      info(`有效状态: ${stateLabel(status.state)}`);
      info(`Preference: ${status.preference ? (status.preference.subscribed ? 'subscribed' : 'unsubscribed') : '默认订阅'}`);
      info(`Suppression: ${status.suppression ? `${status.suppression.reason} (${status.suppression.source})` : '无'}`);
      info(`可普通恢复: ${status.canResubscribe ? '是' : '否'}`);
      info(`更新时间: ${formatTime(status.updatedAt)}`);
      if (status.lastConsent) {
        info(`最近同意: ${formatTime(status.lastConsent.consentAt)} (${status.lastConsent.consentReference})`);
      }
    });

  preferences
    .command('resubscribe <email>')
    .description('使用明确的重新同意证据原子恢复 Workspace 订阅')
    .option('--scope <scope>', '订阅范围（V1 仅支持 workspace）', 'workspace')
    .requiredOption('--source <source>', '重新同意来源，例如 support_ticket 或 customer_portal')
    .requiredOption('--consent-at <timestamp>', '重新同意时间（ISO 8601）')
    .requiredOption('--consent-reference <reference>', '可审计且可重试复用的同意证据引用')
    .action(async (email, opts, command) => {
      if (opts.scope !== 'workspace') throw new Error('--scope V1 仅支持 workspace');
      const res = await (await clientFor(command)).resubscribePreference({
        email,
        scope: 'workspace',
        source: opts.source,
        consentAt: opts.consentAt,
        consentReference: opts.consentReference,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (res.idempotent) {
        success('该重新同意请求已处理过，当前订阅状态保持一致');
      } else if (res.changed) {
        success('订阅已恢复，退订 suppression 与 preference 已原子更新');
      } else {
        info('该收件人当前已经处于订阅状态，无需修改');
      }
      if (res.auditEventId) info(`审计事件: ${res.auditEventId}`);
    });
}
