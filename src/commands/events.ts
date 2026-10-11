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

export function registerEvents(program: Command) {
  const events = program.command('events').description('Ingest and query workflow events');

  events
    .command('track')
    .requiredOption('--file <path>', 'Event JSON file; use - to read from stdin')
    .action(async (opts, command) => {
      const res = await (await clientFor(command)).trackWorkflowEvent(await readJsonInput(opts.file) as any);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Event ${res.event.eventId} ${res.duplicate ? 'already received (idempotent)' : 'received'}`);
      info(`  Workflow runs triggered: ${res.triggeredRunIds?.length ?? 0}`);
      info(`  Workflow runs exited: ${res.exitedRunIds?.length ?? 0}`);
    });

  events
    .command('batch')
    .requiredOption('--file <path>', 'JSON array or {"events": [...]} file; use - to read from stdin')
    .action(async (opts, command) => {
      const input = await readJsonInput(opts.file) as any;
      const batch = Array.isArray(input) ? input : input?.events;
      if (!Array.isArray(batch)) throw new Error('Batch input must be a JSON array or {"events": [...]}.');
      const res = await (await clientFor(command)).trackWorkflowEvents(batch);
      if (getOutputFormat() === 'json') return printJSON(res);
      const succeeded = res.results?.filter((item: any) => item.success).length ?? 0;
      success(`Received ${res.received} events: ${succeeded} succeeded, ${res.received - succeeded} failed`);
    });

  events
    .command('show')
    .argument('<event-id>')
    .action(async (eventId, _opts, command) => {
      const res = await (await clientFor(command)).getWorkflowEvent(eventId);
      if (getOutputFormat() === 'json') return printJSON(res);
      info(`${res.event.eventName} (${res.event.eventId})`);
      info(`  Contact: ${res.event.contact.externalContactId} <${res.event.contact.email}>`);
      info(`  Status: ${res.event.processingStatus}`);
      info(`  Occurred at: ${res.event.occurredAt}`);
      info(`  Workflow Run: ${res.runs?.length ?? 0}`);
    });

  events
    .command('replay')
    .argument('<event-id>')
    .action(async (eventId, _opts, command) => {
      const res = await (await clientFor(command)).replayWorkflowEvent(eventId);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Failed event ${eventId} replayed`);
    });

  events
    .command('timeline')
    .argument('<external-contact-id>')
    .option('--limit <n>', 'Number of results', (value) => Number.parseInt(value, 10))
    .action(async (externalContactId, opts, command) => {
      const res = await (await clientFor(command)).getWorkflowContactTimeline(externalContactId, opts.limit);
      if (getOutputFormat() === 'json') return printJSON(res);
      if (!res.events?.length) return info('No events');
      printTable(['Event', 'Event ID', 'Status', 'Occurred at', 'Triggered', 'Exited'], res.events.map((event: any) => [
        event.eventName,
        event.eventId,
        event.processingStatus,
        event.occurredAt,
        String(event.triggeredRunCount ?? 0),
        String(event.exitedRunCount ?? 0),
      ]));
    });
}
