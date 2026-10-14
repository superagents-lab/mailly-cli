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
  const workflows = program.command('workflows').description('Manage lifecycle email workflows');

  workflows
    .command('list', { isDefault: true })
    .action(async (_opts, command) => {
      const res = await (await clientFor(command)).listWorkflows();
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.workflows?.length) return info('No workflows');
      printTable(['Key', 'Name', 'Status', 'Total runs', 'Active runs', 'Updated at'], res.workflows.map((workflow: any) => [
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
      info(`  Status: ${res.workflow.status}`);
      info(`  Published versions: ${res.versions?.length ?? 0}`);
      info(`  Current version: ${res.versions?.[0]?.version ?? '-'}`);
    });

  workflows
    .command('create')
    .requiredOption('--key <workflow-key>', 'Stable workflow key')
    .requiredOption('--name <name>', 'Workflow name')
    .requiredOption('--file <path>', 'Workflow definition JSON; use - to read from stdin')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).createWorkflow({
        workflowKey: opts.key,
        name: opts.name,
        definition: await readJsonInput(opts.file),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Workflow ${res.workflow.workflowKey} draft created`);
    });

  workflows
    .command('update')
    .argument('<workflow-key>')
    .requiredOption('--file <path>', 'Workflow definition JSON; use - to read from stdin')
    .option('--name <name>', 'Also rename')
    .action(async (workflowKey, opts, command) => {
      const res = await (await clientFor(command)).updateWorkflowDraft(workflowKey, {
        name: opts.name,
        definition: await readJsonInput(opts.file),
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Workflow ${workflowKey} draft updated`);
    });

  workflows
    .command('publish')
    .argument('<workflow-key>')
    .option('--in-flight-policy <policy>', 'How the new version treats in-flight runs (continue)', 'continue')
    .action(async (workflowKey, opts, command) => {
      if (opts.inFlightPolicy !== 'continue' && opts.inFlightPolicy !== 'migrate') {
        throw new Error('--in-flight-policy must be continue or migrate.');
      }
      const res = await (await clientFor(command)).publishWorkflow(workflowKey, {
        inFlightPolicy: opts.inFlightPolicy,
      });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Workflow ${workflowKey} published`);
      info(`  Version ID: ${res.versionId}`);
    });

  for (const action of ['pause', 'resume', 'archive'] as const) {
    workflows
      .command(action)
      .argument('<workflow-key>')
      .action(async (workflowKey, _opts, command) => {
        const res = await (await clientFor(command)).workflowAction(workflowKey, action);
        if (getOutputFormat() === 'json') return printJSON(res);
        const label = { pause: 'paused', resume: 'resumed', archive: 'archived' }[action];
        success(`Workflow ${workflowKey} ${label}`);
        if (res.platformFailures?.length) info(`  Platform operation failures: ${res.platformFailures.length}`);
      });
  }

  workflows
    .command('runs')
    .argument('<workflow-key>')
    .option('--status <status>', 'Filter by run status')
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .option('--offset <n>', 'Pagination offset', (value) => Number.parseInt(value, 10))
    .action(async (workflowKey, opts, command) => {
      const res = await (await clientFor(command)).listWorkflowRuns(workflowKey, opts);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.runs?.length) return info('No workflow runs');
      printTable(['Run ID', 'Contact', 'Email', 'Status', 'Current step', 'Next run'], res.runs.map((run: any) => [
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
      info(`  Status: ${res.run.status}`);
      info(`  Contact: ${res.run.externalContactId} <${res.run.email}>`);
      if (res.run.exitReason) info(`  Exit reason: ${res.run.exitReason}`);
      if (res.run.error) info(`  Error: ${res.run.error}`);
      if (res.sends?.length) {
        info('');
        printTable(['Step', 'Template', 'Recipient', 'Status', 'Reason'], res.sends.map((send: any) => [
          send.stepId,
          `${send.templateKey}@${send.templateVersion}`,
          send.recipientEmail,
          send.status,
          send.statusReason ?? '-',
        ]));
      }
      if (res.logs?.length) {
        info('');
        printTable(['Time', 'Step', 'Action', 'Outcome', 'Reason'], res.logs.map((log: any) => [
          log.createdAt,
          log.stepIndex == null ? '-' : String(log.stepIndex),
          log.action,
          log.outcome,
          log.details?.reason ?? '-',
        ]));
      }
    });

  workflows
    .command('cancel')
    .description('Cancel one queued, running or waiting run; emails already sent are not recalled')
    .argument('<workflow-key>')
    .argument('<run-id>')
    .requiredOption('--reason <text>', 'Why the run is cancelled, kept in the run log')
    .action(async (workflowKey, runId, opts, command) => {
      const res = await (await clientFor(command)).cancelWorkflowRun(workflowKey, runId, { reason: opts.reason });
      if (getOutputFormat() === 'json') return printJSON(res);
      if (res.cancelled) success(`Run ${runId} cancelled`);
      else info(`Run ${runId} had already ended; nothing changed`);
      info(`  Status: ${res.run.status}`);
      if (res.run.exitReason) info(`  Exit reason: ${res.run.exitReason}`);
      if (res.platformFailures?.length) info(`  Platform operation failures: ${res.platformFailures.length}`);
    });
}
