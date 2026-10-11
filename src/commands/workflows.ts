import type { Command } from 'commander';
import { resolveAuth } from '../config.js';
import { MaillyClient } from '../client.js';
import { getOutputFormat, info, printJSON, printTable, success } from '../output.js';
import { readJsonInput } from './jsonInput.js';

async function clientFor(command: Command): Promise<MaillyClient> {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const opts = root.opts() as { apiKey?: string; baseUrl?: string };
  return new MaillyClient(await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl }));
}

export function registerWorkflows(program: Command) {
  const workflows = program.command('workflows').description('生命周期邮件 Workflow 管理');

  workflows
    .command('list', { isDefault: true })
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).listWorkflows();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.workflows?.length) return info('暂无 Workflow');
      printTable(['Key', '名称', '状态', '全部 Run', '活跃 Run', '更新时间'], res.workflows.map((workflow: any) => [
        workflow.workflowKey,
        workflow.name,
        workflow.status,
        String(workflow.runCount ?? 0),
        String(workflow.activeRunCount ?? 0),
        workflow.updatedAt,
      ]));
    });

  workflows
    .command('show')
    .argument('<workflow-key>')
    .action(async (workflowKey, _opts, command) => {
      const res = await (await clientFor(command)).getWorkflow(workflowKey);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${res.workflow.name} (${res.workflow.workflowKey})`);
      info(`  状态: ${res.workflow.status}`);
      info(`  已发布版本: ${res.versions?.length ?? 0}`);
      info(`  当前版本: ${res.versions?.[0]?.version ?? '-'}`);
    });

  workflows
    .command('create')
    .requiredOption('--key <workflow-key>', '稳定的 Workflow Key')
    .requiredOption('--name <name>', 'Workflow 名称')
    .requiredOption('--file <path>', 'Workflow definition JSON；使用 - 从 stdin 读取')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).createWorkflow({
        workflowKey: opts.key,
        name: opts.name,
        definition: await readJsonInput(opts.file),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Workflow ${res.workflow.workflowKey} 草稿已创建`);
    });

  workflows
    .command('update')
    .argument('<workflow-key>')
    .requiredOption('--file <path>', 'Workflow definition JSON；使用 - 从 stdin 读取')
    .option('--name <name>', '同时修改名称')
    .action(async (workflowKey, opts, command) => {
      const res = await (await clientFor(command)).updateWorkflowDraft(workflowKey, {
        name: opts.name,
        definition: await readJsonInput(opts.file),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Workflow ${workflowKey} 草稿已更新`);
    });

  workflows
    .command('publish')
    .argument('<workflow-key>')
    .option('--in-flight-policy <policy>', '新版本对在途 Run 的处理策略（continue）', 'continue')
    .action(async (workflowKey, opts, command) => {
      if (opts.inFlightPolicy !== 'continue' && opts.inFlightPolicy !== 'migrate') {
        throw new Error('--in-flight-policy 必须是 continue 或 migrate。');
      }
      const res = await (await clientFor(command)).publishWorkflow(workflowKey, {
        inFlightPolicy: opts.inFlightPolicy,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Workflow ${workflowKey} 已发布`);
      info(`  Version ID: ${res.versionId}`);
    });

  for (const action of ['pause', 'resume', 'archive'] as const) {
    workflows
      .command(action)
      .argument('<workflow-key>')
      .action(async (workflowKey, _opts, command) => {
        const res = await (await clientFor(command)).workflowAction(workflowKey, action);
        if (getOutputFormat() === 'json') return printJSON(res);
        const label = { pause: '暂停', resume: '继续', archive: '归档' }[action];
        success(`Workflow ${workflowKey} 已${label}`);
        if (res.platformFailures?.length) info(`  平台操作失败: ${res.platformFailures.length}`);
      });
  }

  workflows
    .command('runs')
    .argument('<workflow-key>')
    .option('--status <status>', '按 Run 状态过滤')
    .option('--limit <n>', '返回条数', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', '分页偏移', (value) => Number.parseInt(value, 10))
    .action(async (workflowKey, opts, command) => {
      const res = await (await clientFor(command)).listWorkflowRuns(workflowKey, opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.runs?.length) return info('暂无 Workflow Run');
      printTable(['Run ID', '联系人', '邮箱', '状态', '当前步骤', '下次执行'], res.runs.map((run: any) => [
        run.id,
        run.externalContactId,
        run.email,
        run.status,
        String(run.currentStep ?? 0),
        run.nextActionAt ?? '-',
      ]));
    });

  workflows
    .command('run')
    .argument('<workflow-key>')
    .argument('<run-id>')
    .action(async (workflowKey, runId, _opts, command) => {
      const res = await (await clientFor(command)).getWorkflowRun(workflowKey, runId);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`Run ${res.run.id}`);
      info(`  状态: ${res.run.status}`);
      info(`  联系人: ${res.run.externalContactId} <${res.run.email}>`);
      if (res.run.exitReason) info(`  退出原因: ${res.run.exitReason}`);
      if (res.run.error) info(`  错误: ${res.run.error}`);
      if (res.sends?.length) {
        info('');
        printTable(['Step', 'Template', '收件人', '状态', '原因'], res.sends.map((send: any) => [
          send.stepId,
          `${send.templateKey}@${send.templateVersion}`,
          send.recipientEmail,
          send.status,
          send.statusReason ?? '-',
        ]));
      }
    });
}
