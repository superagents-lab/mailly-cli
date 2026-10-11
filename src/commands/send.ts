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

/** --variables 文件与 --var 覆盖合并；--var 的值一律按字符串处理。 */
async function readSendVariables(
  opts: SendOptions,
): Promise<Record<string, string | number | boolean> | undefined> {
  const values: Record<string, string | number | boolean> = {};
  if (opts.variables) {
    const parsed = await readJsonInput(opts.variables);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('--variables 必须是 JSON 对象');
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error(`--variables 的 ${name} 必须是字符串、数字或布尔值`);
      }
      values[name] = value as string | number | boolean;
    }
  }
  for (const entry of opts.var ?? []) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new Error('--var 格式必须是 <name=value>');
    values[entry.slice(0, separator).trim()] = entry.slice(separator + 1);
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

export function registerSend(program: Command) {
  program
    .command('send')
    .description('发送邮件 — 多收件人和正式 Campaign 自动进入 Queue')
    .option('-t, --to <email>', '收件人邮箱（可重复或用逗号分隔）', collect, [] as string[])
    .option('--recipient <external-id=email>', '带业务 external_id 的收件人（可重复）', collectOne, [] as string[])
    .option('-s, --subject <subject>', '邮件主题')
    .option('--html <html>', '邮件 HTML 正文')
    .option('--html-file <path>', '从文件读取 HTML 正文（与 --html 互斥）')
    .option('--text <text>', '邮件纯文本正文（与 --html 同时给会发 multipart/alternative）')
    .option('--text-file <path>', '从文件读取纯文本正文（与 --text 互斥）')
    .option('-f, --from-email <email>', '发件人邮箱（必填）')
    .option('-n, --from-name <name>', '发件人显示名')
    .option('--reply-to <email>', '回复地址')
    .option('--cc <email>', '抄送（仅批量发送有效）')
    .option('--bcc <email>', '密送（仅批量发送有效）')
    .option('--provider <provider>', '邮件服务商（默认由后端选择）')
    .option('--email-type <type>', '邮件类型：transactional、lifecycle 或 marketing（默认 transactional）')
    .option('--marketing', '营销发送快捷模式（等同于 --email-type marketing）')
    .option('--campaign-key <key>', 'Campaign 幂等键；marketing 模式必填')
    .option('--campaign-name <name>', 'Campaign 显示名称（首次创建时使用）')
    .option('--audience <key>', '包含的用户集 key（可重复）', collect, [] as string[])
    .option('--exclude-audience <key>', '排除的用户集 key（可重复）', collect, [] as string[])
    .option('--test-send', '发送测试邮件，但不占用正式 Campaign 收件人记录')
    .option('--frequency-cap-days <days>', '频控窗口天数', (value) => Number.parseInt(value, 10))
    .option('--frequency-cap-max <count>', '频控窗口内最多营销邮件数', (value) => Number.parseInt(value, 10))
    .option('--topic-exclusion-days <days>', '同 Topic 发送排除窗口天数', (value) => Number.parseInt(value, 10))
    .option('--recipient-reason <reason>', 'Marketing Footer 中的简短收信原因')
    .option('--template-key <key>', '记录生成正文所用的已发布模板 Key（不渲染，仅记录）')
    .option('--template-version <version>', '模板版本；与 --from-template 一起用时选择要渲染的版本', (value) => Number.parseInt(value, 10))
    .option('--from-template <key>', '用已发布模板渲染正文后发送（配合 --var/--variables）')
    .option('--template-draft', '渲染模板草稿而不是已发布版本（需要 --from-template）')
    .option('--locale <locale>', '模板语言；按 exact -> language -> default 回退')
    .option('--var <name=value>', '模板变量（可重复，值按字符串处理）', collectOne, [] as string[])
    .option('--variables <path>', '变量 JSON 文件；使用 - 从 stdin 读取')
    .option('--audience-definition-file <path>', '受众定义 JSON 文件')
    .option('--source-app <app>', '调用方应用标识')
    .option('--utm-file <path>', 'UTM 参数 JSON 文件')
    .option('--business-goal <goal>', 'Campaign 业务目标')
    .option('--schedule-at <time>', '定时发送时间（ISO 8601 或 Unix 秒）')
    .option('--topic <topic>', '生命周期/营销邮件的偏好主题')
    .option('--dry-run', '仅预览 eligible/suppressed 受众，不发送也不扣费')
    .option('--attachment <path>', '添加本地附件（可重复；总计最多 10 个/6MB）', collectOne, [] as string[])
    .option(
      '--inline <content-id=path>',
      '添加 HTML cid: 内嵌图片（可重复）；Campaign 发送最多 10 张、合计 1MB',
      collectOne,
      [] as string[],
    )
    .option('--message-id <message-id>', '指定当前邮件的 RFC Message-ID')
    .option('--in-reply-to <message-id>', '把当前邮件关联为指定 Message-ID 的回复')
    .option('--reference <message-id>', '追加 References Message-ID（可重复，最多 50 个）', collectOne, [] as string[])
    .action(async (opts: SendOptions, command) => {
      const globalOpts = command.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });

      const identifiedRecipients = (opts.recipient ?? []).map((value) => {
        const separator = value.lastIndexOf('=');
        if (separator <= 0 || separator === value.length - 1) {
          throw new Error('--recipient 格式必须是 <external-id=email>');
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
        throw new Error('请使用 --to、--recipient、--audience，或指定已有冻结受众的 --campaign-key');
      }
      const variables = await readSendVariables(opts);
      const client = new MaillyClient(auth);
      let rendered: TemplateRender | undefined;
      if (opts.fromTemplate) {
        if (opts.html || opts.htmlFile || opts.text || opts.textFile) {
          throw new Error('--from-template 的正文来自模板，不能再传 --html/--text 系列参数');
        }
        if (opts.templateKey) throw new Error('--from-template 会自动记录模板 Key，不要再传 --template-key');
        if (opts.templateDraft && opts.templateVersion != null) {
          throw new Error('--template-draft 与 --template-version 不能同时使用');
        }
        const result = await client.renderEmailTemplate(opts.fromTemplate, {
          version: opts.templateVersion,
          draft: opts.templateDraft,
          locale: opts.locale,
          variables: variables ?? {},
        });
        rendered = { ...result.rendered, version: result.version };
      } else if (opts.templateDraft || opts.locale) {
        throw new Error('--template-draft 与 --locale 需要配合 --from-template 使用');
      } else if ((opts.templateKey == null) !== (opts.templateVersion == null)) {
        throw new Error('--template-key 和 --template-version 必须同时提供');
      }

      const subject = opts.subject ?? rendered?.subject;
      const fromEmail = opts.fromEmail ?? rendered?.from.email;
      const fromName = opts.fromName ?? rendered?.from.name;
      if (!subject) throw new Error('请指定邮件主题，使用 --subject <subject>');
      if (!fromEmail) throw new Error('请指定发件人邮箱，使用 --from-email <email>');
      if (opts.emailType && !['transactional', 'lifecycle', 'marketing'].includes(opts.emailType)) {
        throw new Error('--email-type 必须是 transactional、lifecycle 或 marketing');
      }
      if (opts.marketing && opts.emailType === 'lifecycle') {
        throw new Error('--marketing 不能与 --email-type lifecycle 同时使用');
      }
      const emailType = opts.marketing
        ? 'marketing'
        : opts.emailType ?? rendered?.emailType ?? 'transactional';
      const topic = opts.topic ?? rendered?.topic;
      const recipientReason = opts.recipientReason ?? rendered?.recipientReason;
      const frequencyCapDays = opts.frequencyCapDays ?? rendered?.frequencyCap?.days;
      const frequencyCapMax = opts.frequencyCapMax ?? rendered?.frequencyCap?.max;
      if (emailType === 'marketing' && !opts.campaignKey?.trim()) {
        throw new Error('marketing 模式必须指定 --campaign-key');
      }
      if (opts.testSend && !opts.campaignKey?.trim()) {
        throw new Error('--test-send 必须指定 --campaign-key');
      }
      if (opts.testSend && directRecipients.length === 0) {
        throw new Error('--test-send 必须使用明确的内部 --to 收件人');
      }
      if (opts.testSend && opts.dryRun) {
        throw new Error('--test-send 不能与 --dry-run 同时使用');
      }
      if (hasAudience && !opts.campaignKey?.trim()) {
        throw new Error('--audience/--exclude-audience 必须指定 --campaign-key 以冻结受众');
      }
      if (hasAudience && opts.testSend) {
        throw new Error('Campaign 测试发送必须使用明确的内部 --to，不能使用用户集');
      }
      if ((frequencyCapDays == null) !== (frequencyCapMax == null)) {
        throw new Error('--frequency-cap-days 和 --frequency-cap-max 必须同时提供');
      }
      if (opts.topicExclusionDays != null && (
        !Number.isInteger(opts.topicExclusionDays) || opts.topicExclusionDays <= 0 || !topic?.trim()
      )) throw new Error('--topic-exclusion-days 必须是正整数并同时提供 --topic');
      if (
        frequencyCapDays != null &&
        (!Number.isInteger(frequencyCapDays) || frequencyCapDays <= 0 ||
          !Number.isInteger(frequencyCapMax) || frequencyCapMax! <= 0)
      ) {
        throw new Error('frequency cap 必须是正整数');
      }
      if (recipientReason && (recipientReason.length > 300 || /[\r\n]/.test(recipientReason))) {
        throw new Error('--recipient-reason 最多 300 字符且不能包含换行');
      }
      if (opts.html && opts.htmlFile) {
        throw new Error('--html 与 --html-file 不能同时使用');
      }
      if (opts.text && opts.textFile) {
        throw new Error('--text 与 --text-file 不能同时使用');
      }
      // 普通附件的字节要跟着每条队列消息走，只能单收件人直发；
      // Campaign 的 cid: 内嵌图片按 Campaign 存一份，因此群发也支持。
      const hasPlainAttachments = Boolean(opts.attachment?.length);
      const hasInline = Boolean(opts.inline?.length);
      const hasThreadHeaders = Boolean(opts.messageId || opts.inReplyTo || opts.reference?.length);
      const isDirectSingleSend = directRecipients.length === 1 &&
        identifiedRecipients.length === 0 && !hasAudience && !opts.campaignKey;
      if ((hasPlainAttachments || hasThreadHeaders) && !isDirectSingleSend) {
        throw new Error('普通附件和线程参数只支持单个 --to 的非 Campaign 直发');
      }
      if (hasInline && !isDirectSingleSend && !opts.campaignKey?.trim()) {
        throw new Error('--inline 只支持单个 --to 直发，或指定了 --campaign-key 的 Campaign 发送');
      }
      if ((opts.reference?.length ?? 0) > 50) throw new Error('--reference 最多重复 50 次');
      for (const [flag, value] of [
        ['--message-id', opts.messageId],
        ['--in-reply-to', opts.inReplyTo],
        ...((opts.reference ?? []).map((reference) => ['--reference', reference])),
      ] as Array<[string, string | undefined]>) {
        if (value && (value.length > 998 || /[\r\n]/.test(value))) {
          throw new Error(`${flag} 必须是不含换行、最多 998 字符的 Message-ID`);
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
      // 都没给且 stdin 非 TTY，把 stdin 当成 HTML
      if (!html && !text && !process.stdin.isTTY) {
        html = await readStdin();
      }
      if (!html && !text) {
        throw new Error(
          '请提供邮件正文：--html / --html-file / --text / --text-file 或通过 stdin 传入',
        );
      }
      if (opts.inline?.length && !html) throw new Error('--inline 必须同时提供 HTML 正文');
      const attachments = await loadEmailAttachments(opts.attachment, opts.inline);

      const audienceDefinition = opts.audienceDefinitionFile
        ? await readJsonInput(opts.audienceDefinitionFile)
        : undefined;
      const utmInput = opts.utmFile ? await readJsonInput(opts.utmFile) : undefined;
      if (utmInput != null && (
        typeof utmInput !== 'object' || Array.isArray(utmInput) ||
        Object.values(utmInput).some((value) => typeof value !== 'string')
      )) throw new Error('--utm-file 必须包含值均为字符串的 JSON 对象');
      let scheduledAt: number | undefined;
      if (opts.scheduleAt) {
        scheduledAt = /^\d+$/.test(opts.scheduleAt)
          ? Number.parseInt(opts.scheduleAt, 10)
          : Math.floor(Date.parse(opts.scheduleAt) / 1000);
        if (!Number.isInteger(scheduledAt) || scheduledAt <= Math.floor(Date.now() / 1000)) {
          throw new Error('--schedule-at 必须是未来的 ISO 8601 时间或 Unix 秒');
        }
        if (!opts.campaignKey?.trim() || opts.testSend || opts.dryRun) {
          throw new Error('--schedule-at 只支持正式 Campaign，不能与 --test-send 或 --dry-run 同时使用');
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
        // 模板已经在服务端渲染过，行内变量只用于自带正文的发送
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
        throw new Error(res.error || '发送失败');
      }

      const recipientCount = res.eligibleCount ?? directRecipients.length;
      if (opts.dryRun) {
        success('预检完成');
        info(`  输入: ${res.inputCount ?? 0}    去重后: ${res.deduplicatedCount ?? 0}`);
        info(`  重复: ${res.duplicateCount ?? 0}    格式错误: ${res.invalidCount ?? 0}`);
        info(`  已退订: ${res.unsubscribedCount ?? 0}    已发送: ${res.alreadySentCount ?? 0}`);
        info(`  Campaign 已占用: ${res.campaignClaimedCount ?? 0}`);
        info(`  频控排除: ${res.frequencyCappedCount ?? 0}`);
        info(`  Topic 窗口排除: ${res.topicExcludedCount ?? 0}`);
        info(`  最终可发送: ${res.eligibleCount ?? 0}    邮件用量: ${res.requiredEmailUnits ?? 0}`);
        return;
      }
      success(res.message || (isBulk || isQueuedCampaign
        ? `发送任务已入队 (${recipientCount} 个收件人)`
        : '邮件已发送'));
      if (res.scheduled && res.scheduledAt) {
        info(`计划时间: ${c.cyan(new Date(res.scheduledAt * 1000).toISOString())}`);
        if (res.dispatchId) info(`Dispatch ID: ${c.cyan(res.dispatchId)}`);
        return;
      }

      const taskId =
        res.provider_response?.taskId ||
        res.provider_response?.provider_response?.taskId ||
        res.provider_response?.batchId;
      if ((isBulk || isQueuedCampaign) && taskId) {
        info(`Task ID: ${c.cyan(String(taskId))}`);
        info(c.dim(`使用 \`mailly status ${taskId}\` 查询批量发送进度`));
      }
      if ((isBulk || isQueuedCampaign) && !taskId) {
        warn('未在响应中找到 taskId，请通过 `mailly logs` 查看记录');
      }
    });
}
