import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const cliBin = fileURLToPath(new URL('../bin/mailly.mjs', import.meta.url));

async function mockApi(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      webhook: { url: 'https://example.com/hook', active: true, bodyFormat: 'markdown', stripQuotes: false, events: ['email.received'] },
      endpoint: { id: 'whk_1', addressId: 'adr_1', address: 'a@mailly.site', url: 'https://example.com/hook', active: true, bodyFormat: 'text', stripQuotes: false, events: [] },
      deliveries: [], nextCursor: null,
      delivery: { id: 'iwd_1', status: 'delivered', responseStatus: 200, responseBody: 'ok' },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const run = (args) => execFileAsync(process.execPath, [cliBin, '--api-key', 'sk_test', '--base-url', `http://127.0.0.1:${server.address().port}`, ...args, '--json']);
  return { requests, run };
}

test('webhook delivery options become API fields; deliveries can be listed and resent', async (t) => {
  const { requests, run } = await mockApi(t);
  await run(['inbox', 'webhook', 'set', '--url', 'https://example.com/hook',
    '--header', 'Authorization=Bearer a=b', '--keep-header', 'X-Version',
    '--template', '{"text": "{{subject}}"}', '--body-max-chars', '2000',
    '--filter-to', 'a@mailly.site', '--from-exclude', 'noreply@', '--skip-automated',
    '--max-per-minute', '5', '--batch-window', '60', '--max-attempts', '3']);
  assert.deepEqual(requests.at(-1), { method: 'PUT', url: '/inbox/webhook', body: {
    url: 'https://example.com/hook',
    headers: [{ name: 'X-Version' }, { name: 'Authorization', value: 'Bearer a=b' }],
    template: '{"text": "{{subject}}"}', payloadMode: 'template', bodyMaxChars: 2000,
    filters: { toAddresses: ['a@mailly.site'], fromExclude: ['noreply@'], skipAutomated: true },
    maxPerMinute: 5, batchWindowSeconds: 60, maxAttempts: 3,
  } });

  await run(['inbox', 'webhook', 'endpoints', 'update', 'whk_1', '--clear-headers', '--clear-filters', '--max-per-minute', 'off', '--payload', 'raw']);
  assert.deepEqual(requests.at(-1), { method: 'PATCH', url: '/inbox/webhook/endpoints/whk_1', body: {
    headers: [], payloadMode: 'raw', filters: null, maxPerMinute: null,
  } });
  await assert.rejects(run(['inbox', 'webhook', 'endpoints', 'update', 'whk_1', '--batch-window', '5']));

  await run(['inbox', 'webhook', 'deliveries', '--endpoint-id', 'default', '--failed', '--limit', '10']);
  assert.equal(requests.at(-1).url, '/inbox/webhook/deliveries?endpoint_id=default&status=failed&limit=10');
  await run(['inbox', 'webhook', 'redeliver', 'iwd_1']);
  assert.deepEqual(requests.at(-1), { method: 'POST', url: '/inbox/webhook/deliveries/iwd_1/redeliver', body: undefined });
});
