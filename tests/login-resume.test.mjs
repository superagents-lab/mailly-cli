import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const cliDirectory = fileURLToPath(new URL('..', import.meta.url));
const cliBin = fileURLToPath(new URL('../bin/mailly.mjs', import.meta.url));
const deviceToken = 'a'.repeat(64);

async function startMockServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function runLogin(home, baseUrl, args) {
  return execFileAsync(process.execPath, [
    cliBin,
    'login',
    '--base-url', baseUrl,
    ...args,
  ], {
    cwd: cliDirectory,
    env: { ...process.env, HOME: home },
  });
}

test('login --resume completes JSON device authorization without leaking the API key', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mailly-cli-home-'));
  const fullKey = 'sk_live_super_secret_value';
  const baseUrl = await startMockServer(t, async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/cli/auth/poll');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { deviceToken });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, apiKey: fullKey, email: 'owner@example.com' }));
  });

  const result = await runLogin(home, baseUrl, ['--resume', deviceToken, '--json']);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'approved');
  assert.equal(output.email, 'owner@example.com');
  assert.equal(result.stdout.includes(fullKey), false);
  const configPath = join(home, '.mailly', 'config.json');
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { apiKey: fullKey, baseUrl });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal(result.stderr, '');
});

test('login --resume reports pending once and does not block', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'mailly-cli-home-'));
  const baseUrl = await startMockServer(t, (_request, response) => {
    response.writeHead(202, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'pending' }));
  });
  const result = await runLogin(home, baseUrl, ['--resume', deviceToken, '--json']);
  assert.deepEqual(JSON.parse(result.stdout), { success: true, status: 'pending', deviceToken });
  assert.equal(result.stderr, '');
});
