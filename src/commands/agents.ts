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
}

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
    .option('--skills-file <path>', 'JSON array that replaces all skills; use - to read from stdin, [] clears them');
}

async function profileInput(opts: AgentOptions): Promise<AgentInput> {
  if (opts.personaFile === '-' && opts.skillsFile === '-') {
    throw new Error('--persona-file and --skills-file cannot both read from stdin');
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
    if (getOutputFormat() === 'json') return printJSON({ success: true, agent });
    info(`${agent.name} (${agent.id})`);
    info(`Mode: ${agent.mode}`);
    info(`Inbox address: ${agent.bound_address ?? agent.address_id ?? 'not bound'}`);
    info(`Persona and business instructions:\n${agent.persona_prompt || 'not set'}`);
    info(`Sender allowlist: ${agent.allowed_senders_json ?? '[]'}`);
    info(`Skills:\n${JSON.stringify(JSON.parse(agent.skills_json ?? '[]'), null, 2)}`);
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
    .action(async (id, opts: AgentOptions, command) => {
      const body = await profileInput(opts);
      if (!Object.keys(body).length) throw new Error('No fields to update');
      const res = await (await clientFor(command)).updateAgent(id, body);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Agent ${id} updated`);
    });
}
