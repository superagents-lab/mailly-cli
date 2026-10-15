import { Command, Option } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolveAuth } from '../config.js';
import { MaillyClient, type AgentInput } from '../client.js';
import { getOutputFormat, info, printJSON, printTable, success } from '../output.js';
import { readStdin } from '../stdin.js';
import { readJsonInput } from './jsonInput.js';

interface AgentOptions {
  name?: string;
  mode?: AgentInput['mode'];
  persona?: string;
  personaFile?: string;
  addressId?: string;
  unbindAddress?: boolean;
  allowedSenders?: string[];
  clearAllowedSenders?: boolean;
  skillsFile?: string;
  clearSkills?: boolean;
  summaryPrompt?: string;
  summaryPromptFile?: string;
  resetSummaryPrompt?: boolean;
}

const MAX_SUMMARY_PROMPT = 4000;

async function clientFor(command: Command): Promise<MaillyClient> {
  let root = command;
  while (root.parent) root = root.parent;
  return new MaillyClient(await resolveAuth(root.opts()));
}

function addProfileOptions(command: Command) {
  return command
    .addOption(new Option('--mode <mode>', 'off / summarize / draft (defaults to off on create)').choices(['off', 'summarize', 'draft']))
    .addOption(new Option('--persona <text>', 'Persona and business instructions; an empty string clears them').conflicts('personaFile'))
    .addOption(new Option('--persona-file <path>', 'Read a UTF-8 persona file; use - to read from stdin').conflicts('persona'))
    .option('--address-id <id>', 'Inbox address ID to bind')
    .option('--allowed-senders <senders...>', 'Replace the sender allowlist; email addresses or @domains')
    .option('--skills-file <path>', 'JSON array that replaces all skills; use - to read from stdin, [] clears them')
    .addOption(new Option('--summary-prompt <text>', 'Prompt for the summary of each incoming email; without it the default follows the workspace language').conflicts('summaryPromptFile'))
    .addOption(new Option('--summary-prompt-file <path>', 'Read a UTF-8 summary prompt file; use - to read from stdin').conflicts('summaryPrompt'));
}

async function profileInput(opts: AgentOptions): Promise<AgentInput> {
  if ([opts.personaFile, opts.skillsFile, opts.summaryPromptFile].filter((path) => path === '-').length > 1) {
    throw new Error('Only one of --persona-file, --skills-file and --summary-prompt-file can read from stdin');
  }
  const body: AgentInput = {};
  if (opts.name !== undefined) {
    if (!opts.name.trim() || opts.name.length > 100) throw new Error('Name is required, up to 100 characters');
    body.name = opts.name.trim();
  }
  if (opts.mode !== undefined) body.mode = opts.mode;
  if (opts.persona !== undefined) body.persona_prompt = opts.persona;
  if (opts.personaFile !== undefined) {
    body.persona_prompt = opts.personaFile === '-' ? await readStdin() : await readFile(opts.personaFile, 'utf8');
  }
  if (body.persona_prompt !== undefined && body.persona_prompt.length > 8000) {
    throw new Error('Persona and business instructions can be at most 8000 characters');
  }
  if (opts.addressId !== undefined) {
    if (!opts.addressId.trim()) throw new Error('Inbox address ID cannot be empty; use --unbind-address to unbind');
    body.address_id = opts.addressId;
  }
  if (opts.unbindAddress) body.address_id = null;
  if (opts.allowedSenders !== undefined) body.allowed_senders = opts.allowedSenders;
  if (opts.clearAllowedSenders) body.allowed_senders = [];
  if (opts.skillsFile !== undefined) {
    const skills = await readJsonInput(opts.skillsFile);
    if (!Array.isArray(skills)) throw new Error('The skills file must be a JSON array');
    // The API owns the shared Skill schema and validates every item before writing.
    body.skills = skills;
  }
  if (opts.clearSkills) body.skills = [];
  if (opts.summaryPrompt !== undefined) body.summary_prompt = opts.summaryPrompt;
  if (opts.summaryPromptFile !== undefined) {
    body.summary_prompt = opts.summaryPromptFile === '-' ? await readStdin() : await readFile(opts.summaryPromptFile, 'utf8');
  }
  if (typeof body.summary_prompt === 'string' && body.summary_prompt.length > MAX_SUMMARY_PROMPT) {
    throw new Error(`The summary prompt can be at most ${MAX_SUMMARY_PROMPT} characters`);
  }
  if (opts.resetSummaryPrompt) body.summary_prompt = null;
  return body;
}

export function registerAgents(program: Command) {
  const agents = program.command('agents').description('List, create, and update agent profiles and user skills');
  agents.command('list', { isDefault: true }).action(async (_opts, command) => {
    const res = await (await clientFor(command)).listAgents();
    if (getOutputFormat() === 'json') return printJSON(res);
    if (!res.agents.length) return info('No agents');
    printTable(['ID', 'Name', 'Mode', 'Inbox address'], res.agents.map((agent) => [
      agent.id, agent.name, agent.mode, agent.bound_address ?? '-',
    ]));
  });

  agents.command('show').argument('<agent-id>').action(async (id, _opts, command) => {
    // The API exposes the complete workspace profiles through GET /agents.
    const res = await (await clientFor(command)).listAgents();
    const agent = res.agents.find((item) => item.id === id);
    if (!agent) throw new Error(`Agent ${id} not found`);
    if (getOutputFormat() === 'json') return printJSON({ success: true, summary_locale: res.summary_locale, agent });
    info(`${agent.name} (${agent.id})`);
    info(`Mode: ${agent.mode}`);
    info(`Inbox address: ${agent.bound_address ?? agent.address_id ?? 'not bound'}`);
    info(`Persona and business instructions:\n${agent.persona_prompt || 'not set'}`);
    info(`Sender allowlist: ${agent.allowed_senders_json ?? '[]'}`);
    info(`Skills:\n${JSON.stringify(JSON.parse(agent.skills_json ?? '[]'), null, 2)}`);
    if (agent.effective_summary_prompt !== undefined) {
      const source = agent.summary_prompt ? 'custom' : `default for ${res.summary_locale ?? 'en-US'}, follows the workspace language`;
      info(`Summary prompt (${source}):\n${agent.effective_summary_prompt}`);
    }
  });

  addProfileOptions(agents.command('create').requiredOption('--name <name>', 'Agent name'))
    .action(async (opts: AgentOptions & { name: string }, command) => {
      const body = await profileInput(opts);
      const res = await (await clientFor(command)).createAgent({ ...body, name: body.name! });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Agent created: ${res.id}`);
    });

  addProfileOptions(agents.command('update').argument('<agent-id>').option('--name <name>', 'New name'))
    .addOption(new Option('--unbind-address', 'Unbind the inbox address').conflicts('addressId'))
    .addOption(new Option('--clear-allowed-senders', 'Clear the allowlist and accept all senders').conflicts('allowedSenders'))
    .addOption(new Option('--clear-skills', 'Delete all skills').conflicts('skillsFile'))
    .addOption(new Option('--reset-summary-prompt', 'Go back to the default summary prompt, which follows the workspace language').conflicts(['summaryPrompt', 'summaryPromptFile']))
    .action(async (id, opts: AgentOptions, command) => {
      const body = await profileInput(opts);
      if (!Object.keys(body).length) throw new Error('No fields to update');
      const res = await (await clientFor(command)).updateAgent(id, body);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Agent ${id} updated`);
    });
}
