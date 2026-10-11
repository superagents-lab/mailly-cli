import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
const exec = promisify(execFile), bin = fileURLToPath(new URL('../bin/mailly.mjs', import.meta.url));
test('draft CLI preserves multiline body, version and account auth; approval requires explicit confirmation', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let source = ''; for await (const chunk of req) source += chunk;
    requests.push({ url: req.url, method: req.method, body: source ? JSON.parse(source) : undefined, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, draft: { id: 'draft-1' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise((resolve) => server.close(resolve)));
  const run = (args, body) => {
    const p = exec(process.execPath, [bin, '--base-url', `http://127.0.0.1:${server.address().port}`, '--api-key', 'fixture-key', '--json', 'drafts', ...args]);
    p.child.stdin.end(body ? JSON.stringify(body) : ''); return p;
  };
  const text = '您好，\n\n这是最终正文。';
  await run(['save', '--input', '-'], { text, anchor_email_id: 'email-1', idempotency_key: 'stable-key' });
  await run(['update', 'a/b?c', '--input', '-'], { text, revision: 2 });
  await assert.rejects(run(['approve', 'draft-1', '--input', '-'], { text, revision: 2 }));
  await assert.rejects(run(['update', 'draft-1', '--input', '-'], { text, revision: 0 }));
  await run(['approve', 'draft-1', '--input', '-', '--yes'], { text, revision: 2 });
  assert.equal(requests.length, 3); assert.equal(requests[1].url, '/mail-drafts/a%2Fb%3Fc');
  assert.equal(requests[2].url, '/mail-drafts/draft-1/approve'); assert.equal(requests[2].auth, 'Bearer fixture-key');
  assert.deepEqual(requests[2].body, { text, revision: 2 });
});
