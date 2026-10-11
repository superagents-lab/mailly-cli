import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { c, getOutputFormat, info, printJSON, printTable, success } from '../output.js';

function fmtUnix(seconds: number): string {
  if (!seconds) return '-';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function registerDomains(program: Command) {
  const domains = program.command('domains').description('自定义域名收发能力管理');

  domains
    .command('list', { isDefault: true })
    .description('列出当前账户的域名归属、SES 发件和 MX 收件状态')
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
        info('暂无可用发件域名');
        return;
      }
      const rows = res.domains.map((d) => [
        d.domain,
        d.ownershipStatus ?? (d.status === 'verified' ? 'verified' : d.status),
        d.outboundStatus ?? (
          d.status === 'verified' ? 'verified' : d.status === 'rejected' ? 'rejected' : 'not_configured'
        ),
        d.inboundStatus ?? 'not_configured',
        d.isDefault ? '是' : '否',
        fmtUnix(d.createdAt),
      ]);
      printTable(['域名', '归属状态', '发件状态', '收件状态', '默认', '创建时间'], rows);
    });

  domains
    .command('add')
    .description('提交自定义域名归属申请（通过后可分别配置发件或收件）')
    .argument('<domain>', '域名，例如 mail.example.com')
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
        throw new Error(res.error || '提交失败');
      }
      success(res.message || '已提交');
      if (res.domain) {
        info(`  域名 ID: ${c.cyan(res.domain.id)}`);
        info(`  状态: ${res.domain.status}`);
        info('  下一步: 等待域名归属审核。审核通过后可分别配置发件或收件：');
        info('    一键配置（Cloudflare）: mailly dns set-token 后运行 '
          + `mailly domains apply-dns ${res.domain.id}`);
        info(`    手动发件: mailly domains setup-outbound ${res.domain.id}`);
        info('    手动收件: 在 Cloudflare 或实际 DNS 服务商添加 MX（Target smtp.mailly.site，优先级 10）');
        info(`            然后运行 mailly domains verify-inbound ${res.domain.id}`);
        info(`  收件验证通过后: mailly inbox addresses create --domain ${domain.trim().toLowerCase()} --prefix <前缀>`);
        info('  只收件不需要配置 SES；发件需要把 SES 返回的 CNAME 加到 DNS。修改根域名 MX 会影响该域名的全部收件。');
      }
    });

  domains
    .command('verify-inbound')
    .description('检查自定义域名的 MX 是否已指向 Mailly')
    .argument('<domain-id>', 'sender-domains list 返回的域名 ID')
    .action(async (domainId: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.verifyInboundDomain(domainId);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || 'MX 检查失败');
      if (res.ready) {
        success(res.message || '收信 MX 已验证');
        return;
      }
      info(res.message || 'MX 尚未就绪');
      if (res.expectedMx) {
        info(`  MX ${res.expectedMx.priority} ${res.expectedMx.exchange}`);
        info('  请在 Cloudflare「DNS → Records → Add record」或实际 DNS 服务商中添加；根域名的 Name 通常填 @。');
        info('  若根域名已有企业邮箱 MX，请改用独立子域名，避免接管现有收件。');
      }
      if (res.error) info(`  ${res.error}`);
    });

  domains
    .command('setup-outbound')
    .description('为已通过归属审核的域名创建 SES 发件身份，并返回需要添加的 DNS 记录')
    .argument('<domain-id>', 'sender-domains list 返回的域名 ID')
    .action(async (domainId: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.setupOutboundDomain(domainId);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || '启用发件失败');
      if (res.ready) {
        success(res.message || '发件已启用');
        return;
      }
      info(res.message || '请添加 SES 发件 DNS 记录');
      printOutboundDns(res.outboundDnsRecords);
      info(`  保存后运行: mailly domains verify-outbound ${domainId}`);
    });

  domains
    .command('verify-outbound')
    .description('检查 SES 是否已验证该域名的 DKIM 发件记录')
    .argument('<domain-id>', 'sender-domains list 返回的域名 ID')
    .action(async (domainId: string, _opts, command) => {
      const globalOpts = command.parent!.parent!.opts() as { apiKey?: string; baseUrl?: string };
      const auth = await resolveAuth({ apiKey: globalOpts.apiKey, baseUrl: globalOpts.baseUrl });
      const client = new MaillyClient(auth);
      const res = await client.verifyOutboundDomain(domainId);

      if (getOutputFormat() === 'json') {
        printJSON(res);
        return;
      }
      if (!res.success) throw new Error(res.error || '发件检查失败');
      if (res.ready) {
        success(res.message || '发件已启用');
        return;
      }
      info(res.message || 'SES 尚未验证发件记录');
      printOutboundDns(res.outboundDnsRecords);
      if (res.error) info(`  ${res.error}`);
    });

  domains
    .command('apply-dns')
    .description('用已保存的 Cloudflare Token 一键写入该域名所需的 DNS 记录（幂等，可重复运行）')
    .argument('<domain-id>', 'sender-domains list 返回的域名 ID')
    .option('--scope <scope>', '配置范围：all（默认）、outbound（仅发件）、inbound（仅收件）')
    .option('--token <token>', '一次性使用指定的 Cloudflare Token（不保存到服务端）')
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
      if (!res.success && !res.results?.length) throw new Error(res.error || '一键配置 DNS 失败');

      const outcomeLabel: Record<string, string> = {
        created: '新建',
        existing: '已存在',
        conflict: '冲突',
        failed: '失败',
      };
      printTable(
        ['记录', '结果', '说明'],
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
        info('  存在冲突的记录未被修改。请到 Cloudflare DNS 页面确认后再处理（例如已有其他 MX 的根域名建议改用子域名）。');
      }
      info(`  DNS 生效需要几分钟，稍后运行: mailly domains verify-outbound ${domainId} / mailly domains verify-inbound ${domainId}`);
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
  info('  请在 Cloudflare「DNS → Records → Add record」或实际 DNS 服务商中添加（CNAME 必须关闭代理）：');
  printTable(
    ['类型', '名称 / Host', '值', '用途'],
    records.map((record) => [
      record.priority != null ? `${record.type} ${record.priority}` : record.type,
      record.host,
      record.value,
      record.required ? `${record.purpose}（必填）` : `${record.purpose}（建议）`,
    ]),
  );
}
