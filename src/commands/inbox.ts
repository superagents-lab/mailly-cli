import { promises as fs } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient, type InboxBodyFormat, type InboxListOptions, type InboxMessage } from '../client.js';
import { addMailSearchOptions } from '../search.js';
import { getOutputFormat, info, printJSON, printTable, success, warn } from '../output.js';
import { loadEmailAttachments } from '../attachments.js';

const INBOX_BODY_FORMATS = ['text', 'markdown', 'html'] as const;

function parseInboxBodyFormat(value: string): InboxBodyFormat {
  if (INBOX_BODY_FORMATS.includes(value as InboxBodyFormat)) return value as InboxBodyFormat;
  throw new Error(`正文格式只能是 ${INBOX_BODY_FORMATS.join(' / ')}`);
}

function parseInboxFolder(value: string): string {
  if (value === 'inbox' || value === 'quarantine') return value;
  throw new Error('folder 只能是 inbox / quarantine');
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('必须是正整数');
  return parsed;
}

const INBOX_SEARCH_LABELS = {
  sender: '按发件人搜索；--match fuzzy 时也匹配显示名',
  query: '跨收件人、发件人、显示名和主题模糊搜索（不含正文）',
  time: '收件时间',
};

function formatTimestamp(value?: number | null): string {
  return value ? new Date(value * 1000).toISOString() : '-';
}

function truncate(value: string | null | undefined, max = 48): string {
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function printMessage(message: InboxMessage) {
  info(`ID: ${message.id}`);
  info(`会话: ${message.thread_id}`);
  info(`方向: ${message.direction}`);
  info(`发件人: ${message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address}`);
  // 回复默认发给 Reply-To 而不是 From，只在两者不同时提示，避免误判回复对象。
  if (message.reply_to_address && message.reply_to_address !== message.from_address) {
    info(`回复至: ${message.reply_to_address}`);
  }
  info(`收件人: ${message.to_address}`);
  info(`主题: ${message.subject || '(无主题)'}`);
  info(`时间: ${formatTimestamp(message.received_at)}`);
  info(`已读: ${message.is_read ? '是' : '否'}`);
  if (message.folder) info(`文件夹: ${message.folder}`);
  if (message.quarantine_reason) info(`隔离原因: ${message.quarantine_reason}`);
  if (message.authentication_json) info(`收件验证: ${message.authentication_json}`);
  if (message.text_body) info(`\n${message.text_body}`);
  else if (message.html_body) info(`\n${message.html_body}`);
}

async function readOptionalFile(inline: string | undefined, path: string | undefined, label: string) {
  if (inline && path) throw new Error(`${label} 与对应的文件参数不能同时使用`);
  return path ? fs.readFile(path, 'utf8') : inline;
}

function readStateFromOptions(opts: { read?: boolean; unread?: boolean }): boolean {
  if (Boolean(opts.read) === Boolean(opts.unread)) {
    throw new Error('必须且只能指定 --read 或 --unread');
  }
  return Boolean(opts.read);
}

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

export function registerInbox(program: Command) {
  const inbox = program.command('inbox').description('管理收件地址、正文与收件 Webhook');
  const addresses = inbox.command('addresses').description('收件地址管理');

  addresses
    .command('list', { isDefault: true })
    .description('列出当前账户的收件地址和可用域名')
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).listInboxAddresses();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.addresses.length) return info('暂无收件地址');
      printTable(['ID', '地址', '邮件数', '创建时间'], res.addresses.map((address) => [
        address.id,
        address.address,
        String(address.message_count),
        formatTimestamp(address.created_at),
      ]));
    });

  addresses
    .command('create')
    .description('在已启用 MX 收件的域名上创建地址')
    .requiredOption('--domain <domain>', '已完成归属验证和 MX 验证的域名')
    .option('--prefix <prefix>', '地址前缀；省略时由服务端随机生成')
    .action(async (opts: { domain: string; prefix?: string }, command) => {
      const res = await (await clientFor(command)).createInboxAddress({
        domain: opts.domain.trim().toLowerCase(),
        ...(opts.prefix?.trim() ? { prefix: opts.prefix.trim().toLowerCase() } : {}),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.address) throw new Error(res.error || '创建收件地址失败');
      success(`收件地址 ${res.address.address} 已创建`);
    });

  addresses
    .command('delete')
    .description('删除收件地址及其全部邮件和附件')
    .argument('<address-id>', '收件地址 ID')
    .requiredOption('--yes', '确认永久删除该地址及其全部邮件和附件')
    .action(async (addressId: string, _opts: { yes: boolean }, command: Command) => {
      const res = await (await clientFor(command)).deleteInboxAddress(addressId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`收件地址 ${addressId} 及其邮件已删除`);
    });

  const messages = inbox.command('messages').description('读取收件邮件');

  addMailSearchOptions(messages
    .command('list', { isDefault: true })
    .description('分页列出或搜索邮件摘要；读取不会修改已读状态')
    .option('--address-id <id>', '只查看指定收件地址')
    .option('--limit <n>', '返回条数', parsePositiveInteger)
    .option('--cursor <cursor>', '服务端返回的下一页游标')
    .option('--folder <folder>', 'inbox / quarantine（默认 inbox）', parseInboxFolder)
    .option('--sender-domain <domain>', '按发件人域名筛选（忽略大小写的整域名匹配，不含子域名；走索引）'), INBOX_SEARCH_LABELS)
    .action(async (opts: InboxListOptions, command) => {
      const res = await (await clientFor(command)).listInboxMessages(opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.messages.length) return info('暂无邮件');
      printTable(['时间', '状态', '方向', '发件人', '收件人', '主题', 'ID'], res.messages.map((message) => [
        formatTimestamp(message.received_at),
        message.direction === 'outbound' ? '-' : (message.is_read ? '已读' : '未读'),
        message.direction,
        truncate(message.from_address, 30),
        truncate(message.to_address, 30),
        truncate(message.subject),
        message.id,
      ]));
      if (res.cursor) info(`下一页 cursor: ${res.cursor}`);
    });

  messages
    .command('show')
    .description('查看单封邮件详情；读取不会修改已读状态')
    .argument('<message-id>', '邮件 ID')
    .action(async (messageId: string, _opts, command) => {
      const res = await (await clientFor(command)).getInboxMessage(messageId);
      if (getOutputFormat() === 'json') return printJSON(res);
      printMessage(res.message);
    });

  messages
    .command('release')
    .description('将隔离邮件恢复到收件箱；不重放 Webhook 或自动触发 Agent')
    .argument('<message-id>', '邮件 ID')
    .requiredOption('--yes', '确认已检查邮件并恢复到收件箱')
    .action(async (messageId: string, _opts, command) => {
      const res = await (await clientFor(command)).releaseInboxMessage(messageId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`邮件 ${messageId} 已恢复到收件箱`);
    });

  messages
    .command('content')
    .description('无副作用地读取一封邮件的正文')
    .argument('<message-id>', '邮件 ID')
    .option(
      '--format <format>',
      '正文格式：text / markdown / html（默认 text）',
      parseInboxBodyFormat,
      'text',
    )
    .option('--strip-quotes', '去掉发件人客户端附带的引用历史')
    .action(async (
      messageId: string,
      opts: { format: InboxBodyFormat; stripQuotes?: boolean },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).getInboxMessageContent(messageId, {
        format: opts.format,
        stripQuotes: opts.stripQuotes,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      const content = res.content[opts.format];
      if (content == null) return info(`该邮件没有可用的 ${opts.format} 正文`);
      info(content);
      if (opts.stripQuotes && res.content.quotes_stripped === false) {
        warn('未可靠识别引用历史，已返回完整正文');
      }
    });

  messages
    .command('read-state')
    .description('显式设置单封入站邮件的已读状态')
    .argument('<message-id>', '邮件 ID')
    .option('--read', '标记为已读')
    .option('--unread', '标记为未读')
    .action(async (
      messageId: string,
      opts: { read?: boolean; unread?: boolean },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).setInboxMessageReadState(
        messageId,
        readStateFromOptions(opts),
      );
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`邮件 ${messageId} 已标记为${res.is_read ? '已读' : '未读'}`);
    });

  messages
    .command('reply')
    .description('从原收件地址回复邮件（计入邮件用量）')
    .argument('<message-id>', '要回复的邮件 ID')
    .requiredOption('--idempotency-key <key>', '稳定的回复幂等键（8-200 位）')
    .option('--text <text>', '纯文本回复正文')
    .option('--text-file <path>', '从文件读取纯文本回复正文')
    .option('--html <html>', 'HTML 回复正文')
    .option('--html-file <path>', '从文件读取 HTML 回复正文')
    .option('--to <email>', '覆盖回复对象')
    .option('--subject <subject>', '覆盖自动生成的 Re: 主题')
    .option('--from-name <name>', '发件人显示名')
    .option('--attachment <path>', '添加本地附件（可重复；总计最多 10 个/6MB）', (v, p: string[]) => [...p, v], [] as string[])
    .option('--inline <content-id=path>', '添加 HTML cid: 内嵌图片（可重复）', (v, p: string[]) => [...p, v], [] as string[])
    .action(async (
      messageId: string,
      opts: {
        idempotencyKey: string;
        text?: string;
        textFile?: string;
        html?: string;
        htmlFile?: string;
        to?: string;
        subject?: string;
        fromName?: string;
        attachment?: string[];
        inline?: string[];
      },
      command: Command,
    ) => {
      if (!/^[A-Za-z0-9._:-]{8,200}$/.test(opts.idempotencyKey)) {
        throw new Error('--idempotency-key 必须是 8-200 位字母、数字或 . _ : -');
      }
      const text = await readOptionalFile(opts.text, opts.textFile, '--text');
      const html = await readOptionalFile(opts.html, opts.htmlFile, '--html');
      if (!text && !html) throw new Error('回复必须提供 --text/--text-file 或 --html/--html-file');
      if (opts.inline?.length && !html) throw new Error('--inline 必须同时提供 HTML 正文');
      const attachments = await loadEmailAttachments(opts.attachment, opts.inline);
      const res = await (await clientFor(command)).replyToInboxMessage(messageId, {
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(opts.to ? { to: opts.to.trim() } : {}),
        ...(opts.subject ? { subject: opts.subject } : {}),
        ...(opts.fromName ? { fromName: opts.fromName } : {}),
        ...(attachments.length ? { attachments } : {}),
      }, opts.idempotencyKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (res.status === 'processing') {
        info(`回复仍在处理中；request ID: ${res.request_id}`);
        return;
      }
      success(`回复已发送${res.to ? `给 ${res.to}` : ''}`);
      if (res.request_id) info(`Request ID: ${res.request_id}`);
      if (res.thread_id) info(`Thread ID: ${res.thread_id}`);
    });

  messages
    .command('forward')
    .description('从原收件地址把邮件转发给别人（计入邮件用量）；原附件默认一并转发')
    .argument('<message-id>', '要转发的邮件 ID')
    .requiredOption('--to <email>', '转发给谁')
    .requiredOption('--idempotency-key <key>', '稳定的转发幂等键（8-200 位）')
    .option('--text <text>', '纯文本备注（写在转发内容前面）')
    .option('--text-file <path>', '从文件读取纯文本备注')
    .option('--html <html>', 'HTML 备注')
    .option('--html-file <path>', '从文件读取 HTML 备注')
    .option('--subject <subject>', '覆盖自动生成的 Fwd: 主题')
    .option('--from-name <name>', '发件人显示名')
    .option('--no-attachments', '不转发原邮件附件')
    .option('--attachment <path>', '额外添加本地附件（可重复；总计最多 10 个/6MB）', (v, p: string[]) => [...p, v], [] as string[])
    .action(async (
      messageId: string,
      opts: {
        to: string;
        idempotencyKey: string;
        text?: string;
        textFile?: string;
        html?: string;
        htmlFile?: string;
        subject?: string;
        fromName?: string;
        attachments: boolean;
        attachment?: string[];
      },
      command: Command,
    ) => {
      if (!/^[A-Za-z0-9._:-]{8,200}$/.test(opts.idempotencyKey)) {
        throw new Error('--idempotency-key 必须是 8-200 位字母、数字或 . _ : -');
      }
      const text = await readOptionalFile(opts.text, opts.textFile, '--text');
      const html = await readOptionalFile(opts.html, opts.htmlFile, '--html');
      const attachments = await loadEmailAttachments(opts.attachment, []);
      const res = await (await clientFor(command)).forwardInboxMessage(messageId, {
        to: opts.to.trim(),
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(opts.subject ? { subject: opts.subject } : {}),
        ...(opts.fromName ? { fromName: opts.fromName } : {}),
        ...(opts.attachments === false ? { includeAttachments: false } : {}),
        ...(attachments.length ? { attachments } : {}),
      }, opts.idempotencyKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (res.status === 'processing') {
        info(`转发仍在处理中；request ID: ${res.request_id}`);
        return;
      }
      success(`已转发给 ${res.to ?? opts.to}`);
      if (res.request_id) info(`Request ID: ${res.request_id}`);
      if (res.thread_id) info(`Thread ID: ${res.thread_id}`);
    });

  messages
    .command('delete')
    .description('永久删除单封邮件及其存储的正文和附件')
    .argument('<message-id>', '邮件 ID')
    .requiredOption('--yes', '确认永久删除')
    .action(async (messageId: string, _opts: { yes: boolean }, command: Command) => {
      const res = await (await clientFor(command)).deleteInboxMessage(messageId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`邮件 ${messageId} 已删除`);
    });

  const threads = inbox.command('threads').description('按会话查看收件箱');

  addMailSearchOptions(threads
    .command('list', { isDefault: true })
    .description('分页列出或搜索会话摘要（会话内任一邮件匹配即返回整条会话）；读取不会修改已读状态')
    .option('--address-id <id>', '只查看指定收件地址')
    .option('--limit <n>', '返回条数', parsePositiveInteger)
    .option('--cursor <cursor>', '服务端返回的下一页游标')
    .option('--folder <folder>', 'inbox / quarantine（默认 inbox）', parseInboxFolder)
    .option('--sender-domain <domain>', '按发件人域名筛选（忽略大小写的整域名匹配，不含子域名；走索引）'), INBOX_SEARCH_LABELS)
    .action(async (opts: InboxListOptions, command) => {
      const res = await (await clientFor(command)).listInboxThreads(opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.threads.length) return info('暂无会话');
      printTable(['时间', '未读', '邮件数', '主题', 'Thread ID'], res.threads.map((thread) => [
        formatTimestamp(thread.last_received_at),
        String(thread.unread_count),
        String(thread.message_count),
        truncate(thread.latest_message?.subject),
        thread.thread_id,
      ]));
      if (res.cursor) info(`下一页 cursor: ${res.cursor}`);
    });

  threads
    .command('show')
    .description('查看会话内全部邮件；读取不会修改已读状态')
    .argument('<thread-id>', '会话 ID')
    .option('--folder <folder>', 'inbox / quarantine（默认 inbox）', parseInboxFolder)
    .action(async (threadId: string, opts: { folder?: string }, command) => {
      const res = await (await clientFor(command)).getInboxThread(threadId, opts.folder);
      if (getOutputFormat() === 'json') return printJSON(res);
      for (const [index, message] of res.messages.entries()) {
        if (index > 0) info('\n---\n');
        printMessage(message);
      }
    });

  threads
    .command('read-state')
    .description('显式设置会话内全部入站邮件的已读状态')
    .argument('<thread-id>', '会话 ID')
    .option('--read', '标记为已读')
    .option('--unread', '标记为未读')
    .action(async (
      threadId: string,
      opts: { read?: boolean; unread?: boolean },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).setInboxThreadReadState(
        threadId,
        readStateFromOptions(opts),
      );
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`会话 ${threadId} 已标记为${res.is_read ? '已读' : '未读'}（更新 ${res.updated_count} 封）`);
    });

  const replies = inbox.command('replies').description('查询幂等回复请求');

  replies
    .command('show')
    .argument('<request-id>', '回复请求 ID')
    .action(async (requestId: string, _opts, command) => {
      const res = await (await clientFor(command)).getInboxReply(requestId);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`状态: ${res.request.status}`);
      info(`回复邮件 ID: ${res.request.reply_email_id}`);
      if (res.request.response_status != null) info(`响应状态: ${res.request.response_status}`);
    });

  const attachments = inbox.command('attachments').description('下载私有收件附件');

  attachments
    .command('download')
    .argument('<message-id>', '邮件 ID')
    .argument('<attachment-id>', '附件 ID')
    .argument('[output]', '输出文件路径（默认使用原文件名）')
    .option('--force', '覆盖已存在的输出文件')
    .action(async (
      messageId: string,
      attachmentId: string,
      output: string | undefined,
      opts: { force?: boolean },
      command: Command,
    ) => {
      const result = await (await clientFor(command)).downloadInboxAttachment(messageId, attachmentId);
      const target = resolvePath(output || basename(result.filename));
      try {
        await fs.writeFile(target, result.bytes, { flag: opts.force ? 'w' : 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`输出文件已存在：${target}（如需覆盖请加 --force）`);
        }
        throw error;
      }
      if (getOutputFormat() === 'json') {
        return printJSON({
          success: true,
          path: target,
          bytes: result.bytes.byteLength,
          contentType: result.contentType,
        });
      }
      success(`附件已保存到 ${target}`);
    });

  const webhook = inbox.command('webhook').description('配置签名收件 Webhook');

  webhook
    .command('get', { isDefault: true })
    .alias('show')
    .description('查看当前收件 Webhook 配置')
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).getInboxWebhook();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.webhook) return info('尚未配置收件 Webhook');
      info(`URL: ${res.webhook.url}`);
      info(`状态: ${res.webhook.active ? 'active' : 'disabled'}`);
      info(`正文格式: ${res.webhook.bodyFormat}`);
      info(`去引用: ${res.webhook.stripQuotes ? '开启' : '关闭'}`);
      info(`事件: ${res.webhook.events.join(', ')}`);
    });

  webhook
    .command('set')
    .description('创建或更新收件 Webhook')
    .requiredOption('--url <url>', '公开 HTTPS 回调地址')
    .option('--body-format <format>', '推送正文格式：text / markdown / html', parseInboxBodyFormat)
    .option('--strip-quotes', '推送时去掉发件人客户端附带的引用历史')
    .option('--no-strip-quotes', '推送时保留完整引用历史')
    .option('--signing-secret <secret>', '自定义 32-256 字符签名密钥')
    .option('--rotate-secret', '生成新的签名密钥')
    .action(async (
      opts: {
        url: string;
        bodyFormat?: InboxBodyFormat;
        stripQuotes?: boolean;
        signingSecret?: string;
        rotateSecret?: boolean;
      },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).setInboxWebhook({
        url: opts.url.trim(),
        ...(opts.bodyFormat ? { bodyFormat: opts.bodyFormat } : {}),
        ...(typeof opts.stripQuotes === 'boolean' ? { stripQuotes: opts.stripQuotes } : {}),
        ...(opts.signingSecret ? { signingSecret: opts.signingSecret } : {}),
        ...(opts.rotateSecret ? { rotateSecret: true } : {}),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`收件 Webhook 已配置: ${res.webhook.url}`);
      info(`正文格式: ${res.webhook.bodyFormat}`);
      info(`去引用: ${res.webhook.stripQuotes ? '开启' : '关闭'}`);
      if (res.signingSecret) {
        warn('签名密钥只在本次返回，请立即保存：');
        info(res.signingSecret);
      }
    });

  webhook
    .command('delete')
    .alias('disable')
    .description('停用收件 Webhook（保留配置与投递历史）')
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).disableInboxWebhook();
      if (getOutputFormat() === 'json') return printJSON(res);
      success(res.disabled ? '收件 Webhook 已停用' : '没有可停用的收件 Webhook');
    });

  const addressWebhook = webhook
    .command('address')
    .description('配置单个收件地址的专属收件 Webhook（未配置的地址走全局 Webhook）');

  addressWebhook
    .command('get')
    .description('查看某个收件地址的专属 Webhook 配置')
    .argument('<address-id>', '收件地址 ID（mailly inbox addresses list 查看）')
    .action(async (addressId: string, _opts: unknown, command: Command) => {
      const res = await (await clientFor(command)).getInboxWebhookAddressSubscription(addressId);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.subscription) return info('该地址未配置专属 Webhook，走全局 Webhook');
      info(`地址: ${res.subscription.addressId}`);
      info(`URL: ${res.subscription.url}`);
      info(`状态: ${res.subscription.active ? 'active' : 'disabled'}`);
      info(`正文格式: ${res.subscription.bodyFormat}`);
      info(`去引用: ${res.subscription.stripQuotes ? '开启' : '关闭'}`);
    });

  addressWebhook
    .command('set')
    .description('为某个收件地址创建/更新专属 Webhook（此后该地址只推送到此 URL）')
    .argument('<address-id>', '收件地址 ID（mailly inbox addresses list 查看）')
    .requiredOption('--url <url>', '公开 HTTPS 回调地址')
    .option('--body-format <format>', '推送正文格式：text / markdown / html', parseInboxBodyFormat)
    .option('--strip-quotes', '推送时去掉发件人客户端附带的引用历史')
    .option('--no-strip-quotes', '推送时保留完整引用历史')
    .option('--signing-secret <secret>', '自定义 32-256 字符签名密钥')
    .option('--rotate-secret', '生成新的签名密钥')
    .action(async (
      addressId: string,
      opts: {
        url: string;
        bodyFormat?: InboxBodyFormat;
        stripQuotes?: boolean;
        signingSecret?: string;
        rotateSecret?: boolean;
      },
      command: Command,
    ) => {
      const res = await (await clientFor(command)).setInboxWebhookAddressSubscription(addressId, {
        url: opts.url.trim(),
        ...(opts.bodyFormat ? { bodyFormat: opts.bodyFormat } : {}),
        ...(typeof opts.stripQuotes === 'boolean' ? { stripQuotes: opts.stripQuotes } : {}),
        ...(opts.signingSecret ? { signingSecret: opts.signingSecret } : {}),
        ...(opts.rotateSecret ? { rotateSecret: true } : {}),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`地址 ${res.subscription.addressId} 的专属 Webhook 已配置: ${res.subscription.url}`);
      info(`正文格式: ${res.subscription.bodyFormat}`);
      info(`去引用: ${res.subscription.stripQuotes ? '开启' : '关闭'}`);
      if (res.signingSecret) {
        warn('签名密钥只在本次返回，请立即保存：');
        info(res.signingSecret);
      }
    });

  addressWebhook
    .command('delete')
    .alias('remove')
    .description('删除某个收件地址的专属 Webhook，回落到全局 Webhook')
    .argument('<address-id>', '收件地址 ID')
    .action(async (addressId: string, _opts: unknown, command: Command) => {
      const res = await (await clientFor(command)).removeInboxWebhookAddressSubscription(addressId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(res.removed ? '该地址的专属 Webhook 已删除，回落到全局 Webhook' : '该地址没有专属 Webhook');
    });
}
