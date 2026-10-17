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

test('the CLI skill covers the CLI and points inbox setup at auth.md', async () => {
  const skill = await readFile(skillPath, 'utf8');
  assert.match(skill, /^---\nname: mailly\ndescription: Uses the Mailly CLI/);
  assert.match(skill, /Follow https:\/\/mailly\.site\/auth\.md/);
  assert.match(skill, /mailly login <api-key>/);
  assert.match(skill, /Authentication is \*\*not approval to send\*\*/);
  assert.match(skill, /reference\/commands\.md/);
  // Inbox setup lives at mailly.site/auth.md; the skill must not carry a second copy of it.
  assert.doesNotMatch(skillSource, /onboarding\/start|setup_token|mailly\.site\/skill\.md/);
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

test('the published skill is English only', async () => {
  // Agents fetch these files directly; keep them free of CJK text.
  const cjk = /[　-〿㐀-䶿一-鿿＀-￯]/;
  const offending = skillSource.split('\n').filter((line) => cjk.test(line));
  assert.deepEqual(offending, [], `Skill contains non-English text:\n${offending.join('\n')}`);
});
