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
    .addOption(new Option('--mode <mode>', 'off / summarize / draft；创建时默认 off').choices(['off', 'summarize', 'draft']))
    .addOption(new Option('--persona <text>', '人设与业务说明；空字符串清空').conflicts('personaFile'))
    .addOption(new Option('--persona-file <path>', '读取 UTF-8 人设文件；- 从 stdin 读取').conflicts('persona'))
    .option('--address-id <id>', '绑定的收件地址 ID')
    .option('--allowed-senders <senders...>', '替换发件人白名单；邮箱或 @域名')
    .option('--skills-file <path>', '替换全部 Skills 的 JSON 数组；- 从 stdin 读取，[] 清空');
}

async function profileInput(opts: AgentOptions): Promise<AgentInput> {
  if (opts.personaFile === '-' && opts.skillsFile === '-') {
    throw new Error('--persona-file 与 --skills-file 不能同时读取 stdin');
  }
  const body: AgentInput = {};
  if (opts.name !== undefined) {
    if (!opts.name.trim() || opts.name.length > 100) throw new Error('名称必填，最多 100 字符');
    body.name = opts.name.trim();
  }
  if (opts.mode !== undefined) body.mode = opts.mode;
  if (opts.persona !== undefined) body.persona_prompt = opts.persona;
  if (opts.personaFile !== undefined) {
    body.persona_prompt = opts.personaFile === '-' ? await readStdin() : await readFile(opts.personaFile, 'utf8');
  }
  if (body.persona_prompt !== undefined && body.persona_prompt.length > 8000) {
    throw new Error('人设与业务说明最多 8000 字符');
  }
  if (opts.addressId !== undefined) {
    if (!opts.addressId.trim()) throw new Error('收件地址 ID 不能为空；解除绑定请用 --unbind-address');
    body.address_id = opts.addressId;
  }
  if (opts.unbindAddress) body.address_id = null;
  if (opts.allowedSenders !== undefined) body.allowed_senders = opts.allowedSenders;
  if (opts.clearAllowedSenders) body.allowed_senders = [];
  if (opts.skillsFile !== undefined) {
    const skills = await readJsonInput(opts.skillsFile);
    if (!Array.isArray(skills)) throw new Error('Skills 文件必须是 JSON 数组');
    // The API owns the shared Skill schema and validates every item before writing.
    body.skills = skills;
  }
  if (opts.clearSkills) body.skills = [];
  return body;
}

export function registerAgents(program: Command) {
  const agents = program.command('agents').description('查询、创建和更新 Agent 档案与用户 Skills');
  agents.command('list', { isDefault: true }).action(async (_opts, command) => {
    const res = await (await clientFor(command)).listAgents();
    if (getOutputFormat() === 'json') return printJSON(res);
    if (!res.agents.length) return info('暂无 Agent');
    printTable(['ID', '名称', '模式', '收件地址'], res.agents.map((agent) => [
      agent.id, agent.name, agent.mode, agent.bound_address ?? '-',
    ]));
  });

  agents.command('show').argument('<agent-id>').action(async (id, _opts, command) => {
    // The API exposes the complete workspace profiles through GET /agents.
    const res = await (await clientFor(command)).listAgents();
    const agent = res.agents.find((item) => item.id === id);
    if (!agent) throw new Error(`Agent ${id} 不存在`);
    if (getOutputFormat() === 'json') return printJSON({ success: true, agent });
    info(`${agent.name} (${agent.id})`);
    info(`模式: ${agent.mode}`);
    info(`收件地址: ${agent.bound_address ?? agent.address_id ?? '未绑定'}`);
    info(`人设与业务说明:\n${agent.persona_prompt || '未设置'}`);
    info(`发件人白名单: ${agent.allowed_senders_json ?? '[]'}`);
    info(`Skills:\n${JSON.stringify(JSON.parse(agent.skills_json ?? '[]'), null, 2)}`);
  });

  addProfileOptions(agents.command('create').requiredOption('--name <name>', 'Agent 名称'))
    .action(async (opts: AgentOptions & { name: string }, command) => {
      const body = await profileInput(opts);
      const res = await (await clientFor(command)).createAgent({ ...body, name: body.name! });
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Agent 已创建: ${res.id}`);
    });

  addProfileOptions(agents.command('update').argument('<agent-id>').option('--name <name>', '修改名称'))
    .addOption(new Option('--unbind-address', '解除收件地址绑定').conflicts('addressId'))
    .addOption(new Option('--clear-allowed-senders', '清空白名单，允许全部发件人').conflicts('allowedSenders'))
    .addOption(new Option('--clear-skills', '删除全部 Skills').conflicts('skillsFile'))
    .action(async (id, opts: AgentOptions, command) => {
      const body = await profileInput(opts);
      if (!Object.keys(body).length) throw new Error('没有要更新的字段');
      const res = await (await clientFor(command)).updateAgent(id, body);
      if (getOutputFormat() === 'json') return printJSON(res);
      success(`Agent ${id} 已更新`);
    });
}
