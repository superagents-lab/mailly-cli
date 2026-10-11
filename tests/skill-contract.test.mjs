import assert from 'node:assert/strict';
import { access, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProgram } from '../dist/index.js';

// The same tests run in the monorepo (apps/cli, skill at ../../skills) and in the
// exported public repo (skill at ./skills), so resolve whichever layout is present.
async function firstExisting(...candidates) {
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    try {
      await access(path);
      return path;
    } catch {}
  }
  return null;
}

const skillPath = await firstExisting('../skills/mailly/SKILL.md', '../../../skills/mailly/SKILL.md');
const cliReadmePath = fileURLToPath(new URL('../README.md', import.meta.url));
// Only the monorepo has apps/cli two levels up; the public repo has no root README to check.
const insideMonorepo = Boolean(await firstExisting('../../../apps/cli/package.json'));
const monorepoReadmePath = insideMonorepo ? fileURLToPath(new URL('../../../README.md', import.meta.url)) : null;
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const cliBinPath = fileURLToPath(new URL('../bin/mailly.mjs', import.meta.url));

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

test('Mailly Skill never bypasses the CLI with authenticated REST calls', async () => {
  const skill = await readFile(skillPath, 'utf8');
  assert.doesNotMatch(skill, /curl[^\n]*api\.mailly\.site/i);
  assert.doesNotMatch(skill, /Authorization:\s*Bearer/i);
});

test('Mailly docs install the published mailly-cli package, not private sources', async () => {
  const [skill, cliReadme, rootReadme, packageJson] = await Promise.all([
    readFile(skillPath, 'utf8'),
    readFile(cliReadmePath, 'utf8'),
    monorepoReadmePath ? readFile(monorepoReadmePath, 'utf8') : '',
    readFile(packagePath, 'utf8').then(JSON.parse),
  ]);
  const docs = `${skill}\n${cliReadme}\n${rootReadme}`;
  assert.equal(packageJson.name, 'mailly-cli');
  assert.equal(packageJson.private, undefined);
  assert.match(`${skill}\n${cliReadme}`, /npm install -g mailly-cli/);
  assert.doesNotMatch(docs, /@mailly\/cli/);
  // The monorepo is private; public docs must not point users at it.
  assert.doesNotMatch(`${skill}\n${cliReadme}`, /fatwang2\/mailly|\/Volumes\/|monorepo/i);
  assert.equal(await realpath(cliBinPath), cliBinPath);
});

test('every mailly command shown in the Skill exists in the CLI command tree', async () => {
  const skill = await readFile(skillPath, 'utf8');
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
  const skill = await readFile(skillPath, 'utf8');
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
