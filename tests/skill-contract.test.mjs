import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProgram } from '../dist/index.js';

const skillPath = fileURLToPath(new URL('../skills/mailly/SKILL.md', import.meta.url));
const readmePaths = ['../README.md', '../docs/commands.zh-CN.md'].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const cliBinPath = fileURLToPath(new URL('../bin/mailly.mjs', import.meta.url));
const skillSource = (await Promise.all([
  readFile(skillPath, 'utf8'),
  readFile(new URL('../skills/mailly/reference/commands.md', import.meta.url), 'utf8'),
])).join('\n');

function leafCommandPaths(command, prefix = []) {
  return command.commands.flatMap((child) => {
    const path = [...prefix, child.name()];
    return child.commands.length ? leafCommandPaths(child, path) : [path.join(' ')];
  });
}

function skillCommandLines(skill) {
  const lines = skill.split('\n');
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (!line.startsWith('mailly ')) continue;
    while (line.endsWith('\\') && index + 1 < lines.length) {
      line = `${line.slice(0, -1).trim()} ${lines[++index].trim()}`;
    }
    commands.push(line);
  }
  return commands;
}

function resolveExampleCommand(program, line) {
  const tokens = line.slice('mailly '.length).split(/\s+/);
  let command = program;
  for (const token of tokens) {
    const child = command.commands.find((candidate) => (
      candidate.name() === token || candidate.aliases().includes(token)
    ));
    if (!child) break;
    command = child;
  }
  return command;
}

function availableFlags(command) {
  const flags = new Set();
  for (let current = command; current; current = current.parent) {
    for (const option of current.options) {
      if (option.long) flags.add(option.long);
      if (option.short) flags.add(option.short);
    }
  }
  return flags;
}

test('Mailly entry bootstraps through public HTTP without CLI or MCP prerequisites', async () => {
  const skill = await readFile(skillPath, 'utf8');
  assert.match(skill, /POST https:\/\/api\.mailly\.site\/onboarding\/start/);
  assert.match(skill, /no authentication/);
  assert.match(skill, /JSON `\{"name":"chosen-name"\}`/);
  assert.match(skill, /Ask the human.*name if unknown/);
  assert.match(skill, /trimmed and lowercased.*3–64.*a-z0-9\._-.*start and end alphanumeric.*reserved system or official names/);
  assert.match(skill, /`address` \(string `chosen-name@mailly\.site`\)/);
  assert.match(skill, /30 minutes against existing inboxes and pending reservations/);
  assert.match(skill, /HTTP 409 `code=name_taken`: ask for another name; no blind or mass retries/);
  assert.match(skill, /Expiration or cancellation releases the reservation/);
  assert.match(skill, /creating neither a user nor a receiving inbox/);
  assert.match(skill, /explicitly bind \*\*this chosen inbox\*\*.*account quotas/);
  assert.match(skill, /Never substitute an existing account inbox or an auto-generated name; there is no multi-inbox selection/);
  assert.match(skill, /https:\/\/mailly\.site\/onboard using the same API; no agent is required/);
  assert.doesNotMatch(skill, /no body|create or reuse|creation or reuse|selects one/);
  assert.match(skill, /only `verification_url`/);
  assert.match(skill, /Authorization: Bearer <setup_token>/);
  assert.match(skill, /at least 5 seconds/);
  assert.match(skill, /HTTP 410.*HTTP 429.*\*\*stop\*\*/);
  assert.match(skill, /does \*\*not grant agent account access\*\*/);
  assert.match(skill, /external inbox to redeem/);
  assert.match(skill, /success: true, status: "ready", address: \{id, address\}, hint/);
  assert.match(skill, /no `api_key` or other mailbox credentials/);
  assert.match(skill, /report the inbox address and completion, then \*\*STOP\*\*/);
  assert.match(skill, /only polls this setup/);
  assert.match(skill, /cannot read mail, send mail or access the account/);
  assert.match(skill, /10 minutes after human confirmation/);
  assert.match(skill, /authenticated web console.*\/app\/developers/);
  assert.match(skill, /Do not retrieve or scrape.*collect API keys through chat.*auto-authorize MCP\/CLI.*read the inbox immediately/);
  assert.doesNotMatch(skill, /GET https:\/\/api\.mailly\.site\/inbox|Bearer <api_key>|securely store the API key|approve full-account/);
  assert.match(skill, /Neither CLI login nor MCP OAuth is a prerequisite/);
  assert.doesNotMatch(skillSource, /\bmailly onboard\b|onboard\/login/);
});

test('Mailly docs install the published mailly-cli package, not private sources', async () => {
  const [skill, packageJson, ...readmes] = await Promise.all([
    skillSource,
    readFile(packagePath, 'utf8').then(JSON.parse),
    ...readmePaths.map((path) => readFile(path, 'utf8')),
  ]);
  const docs = [skill, ...readmes].join('\n');
  assert.equal(packageJson.name, 'mailly-cli');
  assert.equal(packageJson.private, undefined);
  assert.match(`${skill}\n${readmes[0]}`, /npm install -g mailly-cli/);
  assert.doesNotMatch(docs, /@mailly\/cli/);
  // The Mailly service repo is private; public docs must not point users at it or at local paths.
  assert.doesNotMatch(docs, /fatwang2\/mailly|\/Volumes\/|monorepo/i);
  assert.equal(await realpath(cliBinPath), cliBinPath);
});

test('every mailly command shown in the Skill exists in the CLI command tree', async () => {
  const skill = skillSource;
  const leafPaths = leafCommandPaths(createProgram());
  const commandLines = skillCommandLines(skill);
  const missing = commandLines.filter((line) => {
    const tokens = line.slice('mailly '.length).replace(/\\$/, '').trim().split(/\s+/);
    return !leafPaths.some((path) => {
      const parts = path.split(' ');
      return parts.every((part, index) => tokens[index] === part);
    });
  });
  assert.deepEqual(missing, [], `Skill contains unknown CLI commands:\n${missing.join('\n')}`);
});

test('every option shown in a Mailly Skill command exists on that CLI command', async () => {
  const skill = skillSource;
  const program = createProgram();
  const unknown = [];
  for (const line of skillCommandLines(skill)) {
    const command = resolveExampleCommand(program, line);
    const flags = availableFlags(command);
    for (const flag of line.match(/--[a-z][a-z0-9-]*/gi) ?? []) {
      if (!flags.has(flag)) unknown.push(`${flag}: ${line}`);
    }
  }
  assert.deepEqual(unknown, [], `Skill contains unknown CLI options:\n${unknown.join('\n')}`);
});
