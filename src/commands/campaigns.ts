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
  const campaigns = program.command('campaigns').description('Campaign 查询与控制');

  campaigns
    .command('create')
    .requiredOption('--file <path>', 'Campaign JSON；可含 audience.include/exclude，使用 - 从 stdin 读取')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).createCampaign(await readJsonInput(opts.file));
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Campaign ${res.campaign.campaignKey} 已创建`);
      if (res.audienceSnapshot) {
        info(`  Audience snapshot: ${res.audienceSnapshot.resolvedRecipientCount} 个收件人`);
      }
    });

  campaigns
    .command('list', { isDefault: true })
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).listCampaigns(opts.limit, opts.offset);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.campaigns?.length) return info('暂无 Campaign');
      printTable(['Key', '状态', '类型', '收件人', '更新时间'], res.campaigns.map((campaign: any) => [
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
      info(`  状态: ${res.campaign.status}`);
      info(`  类型: ${res.campaign.emailType}`);
      info(`  发件人: ${res.campaign.senderEmail}`);
      info(`  主题: ${res.campaign.subject}`);
      info(`  收件人状态: ${JSON.stringify(res.recipientCounts ?? {})}`);
      info(`  投递结果: ${JSON.stringify(res.deliveryCounts ?? {})}`);
      info(`  报表: ${JSON.stringify(res.report ?? {})}`);
      if (res.audienceSnapshot) {
        info(`  Audience snapshot: ${res.audienceSnapshot.resolvedRecipientCount}（${res.audienceSnapshot.createdAt} 冻结）`);
      }
    });

  campaigns
    .command('audience')
    .argument('<campaign-key>')
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
    .action(async (campaignKey, opts, command) => {
      const res = await (await clientFor(command)).getCampaignAudience(campaignKey, opts.limit, opts.offset);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`Campaign ${campaignKey} frozen audience: ${res.snapshot.resolvedRecipientCount}`);
      if (res.members?.length) {
        printTable(['External ID', '邮箱', '名称'], res.members.map((member: any) => [
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
        success(`Campaign ${campaignKey} 已${({ pause: '暂停', resume: '继续', cancel: '取消', complete: '完成' } as const)[action]}`);
      });
  }

  campaigns
    .command('update-content')
    .description('修改已暂停 Campaign 的主题和正文；resume 后未投递的收件人会收到新版本')
    .argument('<campaign-key>')
    .option('--subject <subject>', '新的邮件主题')
    .option('--html <html>', '新的 HTML 正文')
    .option('--html-file <path>', '从文件读取 HTML 正文（与 --html 互斥）')
    .option('--text <text>', '新的纯文本正文')
    .option('--text-file <path>', '从文件读取纯文本正文（与 --text 互斥）')
    .option('--drop-html', '删除 HTML 正文，只保留纯文本')
    .option('--drop-text', '删除纯文本正文，只保留 HTML')
    .action(async (campaignKey, opts, command) => {
      if (opts.html && opts.htmlFile) throw new Error('--html 与 --html-file 不能同时使用');
      if (opts.text && opts.textFile) throw new Error('--text 与 --text-file 不能同时使用');
      if (opts.dropHtml && (opts.html || opts.htmlFile)) throw new Error('--drop-html 不能与 --html/--html-file 同时使用');
      if (opts.dropText && (opts.text || opts.textFile)) throw new Error('--drop-text 不能与 --text/--text-file 同时使用');
      const content: { subject?: string; html?: string | null; text?: string | null } = {};
      if (opts.subject) content.subject = opts.subject;
      if (opts.dropHtml) content.html = null;
      else if (opts.html) content.html = opts.html;
      else if (opts.htmlFile) content.html = await fs.readFile(opts.htmlFile, 'utf8');
      if (opts.dropText) content.text = null;
      else if (opts.text) content.text = opts.text;
      else if (opts.textFile) content.text = await fs.readFile(opts.textFile, 'utf8');
      if (Object.keys(content).length === 0) {
        throw new Error('请至少提供 --subject、--html/--html-file、--text/--text-file 之一');
      }
      const res = await (await clientFor(command)).updateCampaignContent(campaignKey, content);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.changed) return info(`Campaign ${campaignKey} 内容没有变化`);
      success(`Campaign ${campaignKey} 内容已更新（第 ${res.campaign?.contentRevision} 版）`);
      info(`  待投递收件人: ${res.deferredRecipientCount ?? 0}，resume 后会按新内容发送`);
    });

  campaigns
    .command('resend-unsent')
    .description('把投递失败的收件人重新入队，并补上冻结受众里从未发出的成员')
    .argument('<campaign-key>')
    .option('--dry-run', '只列出待补发的收件人，不发送也不扣费')
    .action(async (campaignKey, opts, command) => {
      const res = await (await clientFor(command)).resendUnsentCampaignRecipients(campaignKey, {
        dryRun: Boolean(opts.dryRun),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (opts.dryRun) {
        info(`Campaign ${c.cyan(campaignKey)} 待补发: ${res.unsentCount ?? 0}`);
        if (res.unsentRecipients?.length) {
          printTable(['邮箱', '失败原因', '已尝试次数'], res.unsentRecipients.map((recipient: any) => [
            recipient.email,
            recipient.reason ?? '-',
            String(recipient.attempt ?? 1),
          ]));
        }
        if (res.audienceFrozen) info('  该 Campaign 有冻结受众，补发会一并带上从未占用成功的成员');
        return;
      }
      if (!res.eligibleCount) return info(res.message || '没有需要补发的收件人');
      success(`Campaign ${campaignKey} 已补发 ${res.eligibleCount} 个收件人`);
      info(`  投递失败待补发: ${res.unsentCount ?? 0}    本次邮件用量: ${res.requiredEmailUnits ?? res.eligibleCount}`);
    });

  campaigns
    .command('history')
    .argument('<email>')
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
    .action(async (email, opts, command) => {
      const res = await (await clientFor(command)).getContactCampaignHistory(email, opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.history?.length) return info('暂无 Campaign 发送历史');
      printTable(['Campaign', '主题', '状态', '更新时间'], res.history.map((entry: any) => [
        entry.campaign_key,
        entry.subject,
        entry.recipient_status,
        date(entry.recipient_updated_at),
      ]));
    });

  campaigns
    .command('recipients')
    .argument('<campaign-key>')
    .option('--status <status>', '按 recipient 状态过滤')
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
    .action(async (campaignKey, opts, command) => {
      const res = await (await clientFor(command)).listCampaignRecipients(campaignKey, opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.recipients?.length) return info('暂无收件人记录');
      printTable(['邮箱', 'External ID', '发送状态', '投递结果', '原因', '更新时间'], res.recipients.map((recipient: any) => [
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
      success(`已保存 Campaign 收件人结果到 ${target}`);
    });
}
