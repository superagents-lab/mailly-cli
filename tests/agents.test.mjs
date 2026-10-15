import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/mailly.mjs', import.meta.url));
const skill = { id: 'custom-rule', name: '自定义规则', description: '用户定义适用条件', instructions: '# 规则\n\n保留换行与 **Markdown**。\n', enabled: false };

async function fixture(t, response = { success: true, id: 'agent-1' }, status = 200) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const source = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: source ? JSON.parse(source) : undefined });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), 'mailly-agents-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (args, stdin = '') => {
    const pending = exec(process.execPath, [bin, '--api-key', 'local-test-key', '--base-url', `http://127.0.0.1:${server.address().port}`, 'agents', ...args, '--json'], { timeout: 10000 });
    pending.child.stdin.end(stdin);
    return pending;
  };
  return { requests, dir, run };
}

test('create sends authored Skills and exact Markdown; minimal create adds no defaults', async (t) => {
  const { requests, dir, run } = await fixture(t);
  const persona = '# 人设\n保留正文。\n';
  await writeFile(join(dir, 'persona.md'), persona);
  await writeFile(join(dir, 'skills.json'), JSON.stringify([skill]));
  const result = await run(['create', '--name', ' 客服 ', '--mode', 'draft', '--address-id', 'address-1', '--persona-file', join(dir, 'persona.md'), '--skills-file', join(dir, 'skills.json'), '--allowed-senders', '@example.com', 'owner@example.org']);
  assert.deepEqual(JSON.parse(result.stdout), { success: true, id: 'agent-1' });
  assert.deepEqual(requests[0], { method: 'POST', path: '/agents', auth: 'Bearer local-test-key', body: {
    name: '客服', mode: 'draft', address_id: 'address-1', persona_prompt: persona, skills: [skill], allowed_senders: ['@example.com', 'owner@example.org'],
  } });
  await run(['create', '--name', '空白助理']);
  assert.deepEqual(requests[1].body, { name: '空白助理' });
});

test('update preserves omitted fields, escapes IDs, reads stdin and explicitly clears fields', async (t) => {
  const { requests, run } = await fixture(t);
  await run(['update', 'a/b?c', '--name', '新名字']);
  assert.equal(requests[0].method, 'PATCH');
  assert.equal(requests[0].path, '/agents/a%2Fb%3Fc');
  assert.deepEqual(requests[0].body, { name: '新名字' });
  await run(['update', 'agent-1', '--skills-file', '-'], JSON.stringify([skill]));
  assert.deepEqual(requests[1].body, { skills: [skill] });
  await run(['update', 'agent-1', '--persona-file', '-'], skill.instructions);
  assert.deepEqual(requests[2].body, { persona_prompt: skill.instructions });
  await run(['update', 'agent-1', '--persona', '', '--unbind-address', '--clear-allowed-senders', '--clear-skills']);
  assert.deepEqual(requests[3].body, { persona_prompt: '', address_id: null, allowed_senders: [], skills: [] });
  await run(['update', 'agent-1', '--skills-file', '-'], '[]');
  assert.deepEqual(requests[4].body, { skills: [] });
});

test('invalid and conflicting inputs fail with JSON before contacting the API', async (t) => {
  const { requests, dir, run } = await fixture(t);
  for (const args of [
    ['create'], ['create', '--name', '  '], ['create', '--name', 'test', '--mode', 'auto'],
    ['update', 'a'], ['update', 'a', '--address-id', ''],
    ['update', 'a', '--address-id', 'address-1', '--unbind-address'],
    ['update', 'a', '--allowed-senders', '@example.com', '--clear-allowed-senders'],
    ['update', 'a', '--skills-file', '-', '--clear-skills'],
    ['update', 'a', '--persona', 'text', '--persona-file', '-'],
    ['update', 'a', '--persona-file', '-', '--skills-file', '-'],
    ['update', 'a', '--skills-file', join(dir, 'missing.json')],
  ]) {
    await assert.rejects(run(args), (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).success, false);
      return true;
    });
  }
  for (const input of ['{invalid', '{"skills":[]}', 'null']) {
    await assert.rejects(run(['update', 'a', '--skills-file', '-'], input), (error) => {
      assert.equal(JSON.parse(error.stdout).success, false);
      return true;
    });
  }
  assert.deepEqual(requests, []);
});

test('list and show expose stored profiles; missing profile fails', async (t) => {
  const agent = { id: 'agent-1', name: '客服', mode: 'off', persona_prompt: '', bound_address: null, address_id: null, allowed_senders_json: null, skills_json: JSON.stringify([skill]) };
  const { run, requests } = await fixture(t, { success: true, agents: [agent] });
  for (const args of [[], ['list']]) {
    assert.deepEqual(JSON.parse((await run(args)).stdout), { success: true, agents: [agent] });
  }
  assert.deepEqual(JSON.parse((await run(['show', 'agent-1'])).stdout), { success: true, agent });
  await assert.rejects(run(['show', 'missing']), (error) => {
    assert.match(JSON.parse(error.stdout).error, /not found/);
    return true;
  });
  assert.ok(requests.every((req) => req.method === 'GET' && req.path === '/agents'));
});

test('server validation errors surface as JSON and nonzero exit', async (t) => {
  const { run, requests } = await fixture(t, { success: false, error: '技能 ID 格式无效或重复' }, 400);
  await assert.rejects(run(['update', 'agent-1', '--skills-file', '-'], JSON.stringify([skill, skill])), (error) => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stdout).error, /技能 ID 格式无效或重复/);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('runs list passes filters, show/discard escape IDs, approve sends the reviewed text', async (t) => {
  const { requests, dir, run } = await fixture(t, { success: true, runs: [] });
  assert.deepEqual(JSON.parse((await run(['runs'])).stdout), { success: true, runs: [] });
  assert.equal(requests[0].path, '/agents/runs');
  await run(['runs', 'list', '--agent-id', 'agent-1', '--approval-status', 'pending', '--limit', '20']);
  assert.equal(requests[1].path, '/agents/runs?agent_id=agent-1&approval_status=pending&limit=20');
  await run(['runs', 'show', 'r/1']);
  assert.deepEqual([requests[2].method, requests[2].path], ['GET', '/agents/runs/r%2F1']);
  const reply = '您好，\n已收到，明天回复。\n';
  await writeFile(join(dir, 'reply.txt'), reply);
  await run(['runs', 'approve', 'run-1', '--text-file', join(dir, 'reply.txt'), '--yes']);
  assert.deepEqual(requests[3], { method: 'POST', path: '/agents/runs/run-1/approve', auth: 'Bearer local-test-key', body: { text: reply } });
  await run(['runs', 'approve', 'run-1', '--text-file', '-', '--yes'], reply);
  assert.deepEqual(requests[4].body, { text: reply });
  await run(['runs', 'discard', 'run-1']);
  assert.deepEqual([requests[5].method, requests[5].path, requests[5].body], ['POST', '/agents/runs/run-1/discard', undefined]);
});

test('runs approve requires --yes and non-blank text; bad limit fails before the API', async (t) => {
  const { requests, dir, run } = await fixture(t);
  await writeFile(join(dir, 'reply.txt'), 'ok');
  for (const [args, stdin] of [
    [['runs', 'approve', 'run-1', '--text-file', join(dir, 'reply.txt')], ''],
    [['runs', 'approve', 'run-1', '--yes'], ''],
    [['runs', 'approve', 'run-1', '--text-file', '-', '--yes'], '   \n'],
    [['runs', 'list', '--limit', '0'], ''],
    [['runs', 'list', '--limit', 'abc'], ''],
  ]) {
    await assert.rejects(run(args, stdin), (error) => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).success, false);
      return true;
    });
  }
  assert.deepEqual(requests, []);
});

test('approve surfaces a 409 from the server', async (t) => {
  const { run } = await fixture(t, { success: false, error: 'This draft is no longer awaiting approval' }, 409);
  await assert.rejects(run(['runs', 'approve', 'run-1', '--text-file', '-', '--yes'], 'hi'), (error) => {
    assert.match(JSON.parse(error.stdout).error, /no longer awaiting approval/);
    return true;
  });
});
