import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const cliDirectory = fileURLToPath(new URL('..', import.meta.url));
const cliBin = fileURLToPath(new URL('../bin/mailly.mjs', import.meta.url));

async function startMockServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function runCli(baseUrl, args) {
  return execFileAsync(process.execPath, [
    cliBin,
    '--api-key', 'sk_test',
    '--base-url', baseUrl,
    ...args,
  ], { cwd: cliDirectory });
}

test('quarantine CLI passes folder filters and requires explicit confirmation to release', async (t) => {
  const requests = [];
  const baseUrl = await startMockServer(t, (request, response) => {
    requests.push([request.method, request.url]);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, messages: [], threads: [], cursor: null }));
  });
  await runCli(baseUrl, ['inbox', 'messages', 'list', '--folder', 'quarantine', '--json']);
  await runCli(baseUrl, ['inbox', 'threads', 'list', '--folder', 'quarantine', '--json']);
  await runCli(baseUrl, ['inbox', 'threads', 'show', 'thread-1', '--folder', 'quarantine', '--json']);
  await assert.rejects(runCli(baseUrl, ['inbox', 'messages', 'release', 'email-1', '--json']));
  assert.equal(requests.length, 3);
  await runCli(baseUrl, ['inbox', 'messages', 'release', 'email-1', '--yes', '--json']);
  assert.deepEqual(requests, [
    ['GET', '/inbox/messages?folder=quarantine'],
    ['GET', '/inbox/threads?folder=quarantine'],
    ['GET', '/inbox/threads/thread-1?folder=quarantine'],
    ['POST', '/inbox/messages/email-1/release'],
  ]);
});

test('inbox and outbox list commands pass recipient, sender, subject and match search params', async (t) => {
  const requests = [];
  const baseUrl = await startMockServer(t, (request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true, messages: [], threads: [], cursor: null, total: 0, limit: 50, offset: 0, hasMore: false,
    }));
  });
  await runCli(baseUrl, ['inbox', 'messages', 'list', '--recipient', 'support@mailly.site', '--json']);
  await runCli(baseUrl, [
    'inbox', 'threads', 'list', '--sender', 'carol', '--subject', 'refund', '--match', 'fuzzy', '--json',
  ]);
  await runCli(baseUrl, ['inbox', 'messages', 'list', '--query', '100%', '--json']);
  await runCli(baseUrl, ['outbox', 'list', '--recipient', 'alic', '--sender', 'billing@', '--match', 'fuzzy', '--json']);
  await runCli(baseUrl, [
    'inbox', 'messages', 'list', '--since', '2026-09-01T00:00:00Z', '--until', '1788220800', '--json',
  ]);
  await runCli(baseUrl, ['inbox', 'threads', 'list', '--sender-domain', 'customer.io', '--subject', 'refund', '--match', 'fuzzy', '--json']);
  await assert.rejects(runCli(baseUrl, ['inbox', 'threads', 'list', '--sender', 'a', '--match', 'regex', '--json']));
  await assert.rejects(runCli(baseUrl, ['outbox', 'list', '--sender-domain', 'customer.io', '--json']));
  await assert.rejects(runCli(baseUrl, ['outbox', 'list', '--since', 'yesterday', '--json']));
  await assert.rejects(runCli(baseUrl, ['outbox', 'list', '--until', '2026-02-31', '--json']));
  assert.deepEqual(requests.map((url) => {
    const parsed = new URL(url, 'http://localhost');
    return [parsed.pathname, Object.fromEntries(parsed.searchParams)];
  }), [
    ['/inbox/messages', { recipient: 'support@mailly.site' }],
    ['/inbox/threads', { sender: 'carol', subject: 'refund', match: 'fuzzy' }],
    ['/inbox/messages', { q: '100%' }],
    ['/sent-messages', { recipient: 'alic', sender: 'billing@', match: 'fuzzy' }],
    ['/inbox/messages', { since: '1788220800', until: '1788220800' }],
    ['/inbox/threads', { sender_domain: 'customer.io', subject: 'refund', match: 'fuzzy' }],
  ]);
});

test('date-only --since/--until cover whole local days in the caller timezone', async (t) => {
  const requests = [];
  const baseUrl = await startMockServer(t, (request, response) => {
    requests.push(new URL(request.url, 'http://localhost').searchParams);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, messages: [], threads: [], cursor: null }));
  });
  const run = (tz) => execFileAsync(process.execPath, [
    cliBin, '--api-key', 'sk_test', '--base-url', baseUrl,
    'inbox', 'threads', 'list', '--since', '2026-09-01', '--until', '2026-09-30', '--json',
  ], { cwd: cliDirectory, env: { ...process.env, TZ: tz } });
  await run('Asia/Shanghai');
  await run('UTC');
  assert.deepEqual(requests.map((params) => [params.get('since'), params.get('until')]), [
    [String(Date.parse('2026-08-31T16:00:00Z') / 1000), String(Date.parse('2026-09-30T16:00:00Z') / 1000)],
    [String(Date.parse('2026-09-01T00:00:00Z') / 1000), String(Date.parse('2026-10-01T00:00:00Z') / 1000)],
  ]);
});

test('inbox addresses create sends the selected domain and normalized prefix', async (t) => {
  let resolveRequest;
  const receivedRequest = new Promise((resolve) => { resolveRequest = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    resolveRequest({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      address: {
        id: 'address-1',
        address: 'tickets@inbound.example',
        created_at: 10,
        message_count: 0,
      },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const child = execFileAsync(process.execPath, [
    cliBin,
    '--api-key', 'sk_test',
    '--base-url', `http://127.0.0.1:${address.port}`,
    'inbox', 'addresses', 'create',
    '--domain', 'Inbound.Example',
    '--prefix', 'Tickets',
    '--json',
  ], { cwd: cliDirectory });

  const [request, result] = await Promise.all([receivedRequest, child]);
  assert.deepEqual(request, {
    method: 'POST',
    url: '/inbox/addresses',
    authorization: 'Bearer sk_test',
    body: { domain: 'inbound.example', prefix: 'tickets' },
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    success: true,
    address: {
      id: 'address-1',
      address: 'tickets@inbound.example',
      created_at: 10,
      message_count: 0,
    },
  });
  assert.equal(result.stderr, '');
});

test('domains add explains the external DNS step before inbox address creation', async (t) => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/sender-domains');
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), { domain: 'pulseticker.app' });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      message: '域名已提交，等待归属审核',
      domain: {
        id: 'domain-pulse',
        domain: 'pulseticker.app',
        status: 'pending',
      },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = await execFileAsync(process.execPath, [
    cliBin,
    '--api-key', 'sk_test',
    '--base-url', `http://127.0.0.1:${address.port}`,
    'domains', 'add', 'pulseticker.app',
  ], { cwd: cliDirectory });

  assert.match(result.stdout, /Cloudflare or your actual DNS provider/);
  assert.match(result.stdout, /MX.*smtp\.mailly\.site.*priority 10/);
  assert.match(result.stdout, /mailly domains setup-outbound domain-pulse/);
  assert.match(result.stdout, /mailly domains verify-inbound domain-pulse/);
  assert.match(result.stdout, /Receiving only does not need SES/);
  assert.match(result.stdout, /Changing the root domain MX affects all mail received on that domain/);
  assert.equal(result.stderr, '');
});

test('inbox messages content requests markdown with quote stripping', async (t) => {
  const responseBody = {
    success: true,
    content: {
      id: 'message/with space',
      markdown: '# New reply',
      text_truncated: false,
      html_truncated: false,
      text_source: 'plain',
      has_html: true,
      quotes_stripped: true,
      attachments: [],
    },
  };
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(
      request.url,
      '/inbox/messages/message%2Fwith%20space/content?format=markdown&strip_quotes=true',
    );
    assert.equal(request.headers.authorization, 'Bearer sk_test');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  });

  const result = await runCli(baseUrl, [
    'inbox', 'messages', 'content', 'message/with space',
    '--format', 'markdown',
    '--strip-quotes',
    '--json',
  ]);

  assert.deepEqual(JSON.parse(result.stdout), responseBody);
  assert.equal(result.stderr, '');
});

test('inbox webhook get reads the current configuration', async (t) => {
  const responseBody = {
    success: true,
    webhook: {
      url: 'https://example.com/inbox',
      active: true,
      bodyFormat: 'markdown',
      stripQuotes: true,
      events: ['email.received'],
      signingSecretConfigured: true,
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
  };
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/inbox/webhook');
    assert.equal(request.headers.authorization, 'Bearer sk_test');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  });

  const result = await runCli(baseUrl, ['inbox', 'webhook', 'get', '--json']);

  assert.deepEqual(JSON.parse(result.stdout), responseBody);
  assert.equal(result.stderr, '');
});

test('inbox webhook set configures body format, quote stripping, and secret rotation', async (t) => {
  const baseUrl = await startMockServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.method, 'PUT');
    assert.equal(request.url, '/inbox/webhook');
    assert.equal(request.headers.authorization, 'Bearer sk_test');
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
      url: 'https://example.com/inbox',
      bodyFormat: 'markdown',
      stripQuotes: true,
      rotateSecret: true,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      webhook: {
        url: 'https://example.com/inbox',
        active: true,
        bodyFormat: 'markdown',
        stripQuotes: true,
        events: ['email.received'],
      },
      signingSecret: 'whsec_test',
    }));
  });

  const result = await runCli(baseUrl, [
    'inbox', 'webhook', 'set',
    '--url', 'https://example.com/inbox',
    '--body-format', 'markdown',
    '--strip-quotes',
    '--rotate-secret',
    '--json',
  ]);

  assert.equal(JSON.parse(result.stdout).signingSecret, 'whsec_test');
  assert.equal(result.stderr, '');
});

test('inbox webhook set omits unchanged optional settings', async (t) => {
  const baseUrl = await startMockServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
      url: 'https://example.com/updated',
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      webhook: {
        url: 'https://example.com/updated',
        active: true,
        bodyFormat: 'html',
        stripQuotes: true,
        events: ['email.received'],
      },
    }));
  });

  const result = await runCli(baseUrl, [
    'inbox', 'webhook', 'set',
    '--url', 'https://example.com/updated',
    '--json',
  ]);

  assert.equal(JSON.parse(result.stdout).webhook.bodyFormat, 'html');
  assert.equal(result.stderr, '');
});

test('inbox webhook set can explicitly turn quote stripping off', async (t) => {
  const baseUrl = await startMockServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
      url: 'https://example.com/inbox',
      stripQuotes: false,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      webhook: {
        url: 'https://example.com/inbox',
        active: true,
        bodyFormat: 'text',
        stripQuotes: false,
        events: ['email.received'],
      },
    }));
  });

  const result = await runCli(baseUrl, [
    'inbox', 'webhook', 'set',
    '--url', 'https://example.com/inbox',
    '--no-strip-quotes',
    '--json',
  ]);

  assert.equal(JSON.parse(result.stdout).webhook.stripQuotes, false);
  assert.equal(result.stderr, '');
});

test('inbox webhook delete disables the configuration', async (t) => {
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'DELETE');
    assert.equal(request.url, '/inbox/webhook');
    assert.equal(request.headers.authorization, 'Bearer sk_test');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, disabled: true }));
  });

  const result = await runCli(baseUrl, ['inbox', 'webhook', 'delete', '--json']);

  assert.deepEqual(JSON.parse(result.stdout), { success: true, disabled: true });
  assert.equal(result.stderr, '');
});

test('inbox webhook address get reads a per-address subscription', async (t) => {
  const responseBody = {
    success: true,
    subscription: {
      addressId: 'address-1',
      address: 'subscriptions@inbox.example.com',
      url: 'https://hooks.example.com/v1/hooks/hks_test',
      active: true,
      bodyFormat: 'markdown',
      stripQuotes: true,
      events: ['email.received'],
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
  };
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/inbox/webhook/addresses/address-1');
    assert.equal(request.headers.authorization, 'Bearer sk_test');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  });

  const result = await runCli(baseUrl, ['inbox', 'webhook', 'address', 'get', 'address-1', '--json']);

  assert.deepEqual(JSON.parse(result.stdout), responseBody);
  assert.equal(result.stderr, '');
});

test('inbox webhook address get reports no subscription as fallback', async (t) => {
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/inbox/webhook/addresses/address-1');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, subscription: null }));
  });

  const result = await runCli(baseUrl, ['inbox', 'webhook', 'address', 'get', 'address-1', '--json']);

  assert.deepEqual(JSON.parse(result.stdout), { success: true, subscription: null });
  assert.equal(result.stderr, '');
});

test('inbox webhook address delete removes the per-address subscription', async (t) => {
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'DELETE');
    assert.equal(request.url, '/inbox/webhook/addresses/address-1');
    assert.equal(request.headers.authorization, 'Bearer sk_test');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, removed: true }));
  });

  const result = await runCli(baseUrl, ['inbox', 'webhook', 'address', 'delete', 'address-1', '--json']);

  assert.deepEqual(JSON.parse(result.stdout), { success: true, removed: true });
  assert.equal(result.stderr, '');
});

const sampleEndpoint = {
  id: 'whk_000000000000000000000001',
  addressId: 'address-1',
  address: 'tickets@inbox.example.com',
  url: 'https://hooks.example.com/a',
  active: true,
  bodyFormat: 'markdown',
  stripQuotes: true,
  events: ['email.received'],
  signingSecretConfigured: true,
  lastTest: null,
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
};

function collectJson(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => resolve(raw ? JSON.parse(raw) : undefined));
  });
}

test('inbox webhook endpoints list, add, update, and delete call the endpoint API', async (t) => {
  const requests = [];
  const baseUrl = await startMockServer(t, async (request, response) => {
    requests.push([request.method, request.url, await collectJson(request)]);
    response.writeHead(request.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    if (request.method === 'GET') return response.end(JSON.stringify({ success: true, endpoints: [sampleEndpoint] }));
    if (request.method === 'DELETE') return response.end(JSON.stringify({ success: true, removed: true }));
    response.end(JSON.stringify({ success: true, endpoint: sampleEndpoint, signingSecret: 'whsec_once' }));
  });

  const listed = await runCli(baseUrl, ['inbox', 'webhook', 'endpoints', 'list', '--address-id', 'address-1', '--json']);
  assert.equal(JSON.parse(listed.stdout).endpoints[0].id, sampleEndpoint.id);
  await runCli(baseUrl, [
    'inbox', 'webhook', 'endpoints', 'add',
    '--address-id', 'address-1',
    '--url', ' https://hooks.example.com/b ',
    '--body-format', 'markdown',
    '--strip-quotes',
    '--json',
  ]);
  await runCli(baseUrl, [
    'inbox', 'webhook', 'endpoints', 'update', sampleEndpoint.id,
    '--no-strip-quotes', '--disable', '--rotate-secret', '--json',
  ]);
  await runCli(baseUrl, ['inbox', 'webhook', 'endpoints', 'delete', sampleEndpoint.id, '--json']);

  assert.deepEqual(requests, [
    ['GET', '/inbox/webhook/endpoints?address_id=address-1', undefined],
    ['POST', '/inbox/webhook/endpoints', {
      addressId: 'address-1',
      url: 'https://hooks.example.com/b',
      bodyFormat: 'markdown',
      stripQuotes: true,
    }],
    ['PATCH', `/inbox/webhook/endpoints/${sampleEndpoint.id}`, { stripQuotes: false, active: false, rotateSecret: true }],
    ['DELETE', `/inbox/webhook/endpoints/${sampleEndpoint.id}`, undefined],
  ]);
});

test('inbox webhook endpoints update rejects an empty update and conflicting state flags', async (t) => {
  let called = false;
  const baseUrl = await startMockServer(t, (_request, response) => {
    called = true;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });

  await assert.rejects(runCli(baseUrl, ['inbox', 'webhook', 'endpoints', 'update', sampleEndpoint.id]), /Nothing to update/);
  await assert.rejects(
    runCli(baseUrl, ['inbox', 'webhook', 'endpoints', 'update', sampleEndpoint.id, '--enable', '--disable']),
    /either --enable or --disable/,
  );
  assert.equal(called, false);
});

test('inbox webhook endpoints test reports success and exits non-zero on a failed delivery', async (t) => {
  let ok = true;
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `/inbox/webhook/endpoints/${sampleEndpoint.id}/test`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      test: {
        ok,
        eventId: 'evt_test',
        responseStatus: ok ? 204 : 500,
        error: ok ? null : 'HTTP 500',
        durationMs: 42,
        testedAt: '2026-10-12T00:00:00.000Z',
      },
      endpoint: sampleEndpoint,
    }));
  });

  const passed = await runCli(baseUrl, ['inbox', 'webhook', 'endpoints', 'test', sampleEndpoint.id]);
  assert.match(passed.stdout, /Test event delivered to https:\/\/hooks\.example\.com\/a \(HTTP 204, 42 ms\)/);

  ok = false;
  const failed = await runCli(baseUrl, ['inbox', 'webhook', 'endpoints', 'test', sampleEndpoint.id, '--json'])
    .then(() => assert.fail('expected a non-zero exit'), (error) => error);
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(failed.stdout).test.ok, false);
});

test('inbox webhook test sends a test event to the default webhook', async (t) => {
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/inbox/webhook/test');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      test: { ok: true, eventId: 'evt_test', responseStatus: 200, error: null, durationMs: 10, testedAt: '2026-10-12T00:00:00.000Z' },
    }));
  });

  const result = await runCli(baseUrl, ['inbox', 'webhook', 'test', '--json']);
  assert.equal(JSON.parse(result.stdout).test.eventId, 'evt_test');
});

test('inbox addresses list uses the authenticated CLI client', async (t) => {
  const responseBody = {
    success: true,
    domain: 'mailly.site',
    domains: [],
    addresses: [{ id: 'address-1', address: 'tickets@example.com', created_at: 10, message_count: 2 }],
  };
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/inbox/addresses');
    assert.equal(request.headers.authorization, 'Bearer sk_test');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  });
  const result = await runCli(baseUrl, ['inbox', 'addresses', 'list', '--json']);
  assert.deepEqual(JSON.parse(result.stdout), responseBody);
  assert.equal(result.stderr, '');
});

test('inbox message and thread list commands preserve cursor pagination', async (t) => {
  const requests = [];
  const baseUrl = await startMockServer(t, (request, response) => {
    requests.push(new URL(request.url, baseUrl));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url.startsWith('/inbox/messages')
      ? { success: true, messages: [], cursor: null }
      : { success: true, threads: [], cursor: null }));
  });
  await runCli(baseUrl, [
    'inbox', 'messages', 'list', '--address-id', 'address/1', '--limit', '7', '--cursor', '10|message/1', '--json',
  ]);
  await runCli(baseUrl, [
    'inbox', 'threads', 'list', '--address-id', 'address/1', '--limit', '8', '--cursor', '11|thread/1', '--json',
  ]);
  assert.equal(requests[0].pathname, '/inbox/messages');
  assert.deepEqual(Object.fromEntries(requests[0].searchParams), {
    address_id: 'address/1', limit: '7', cursor: '10|message/1',
  });
  assert.equal(requests[1].pathname, '/inbox/threads');
  assert.deepEqual(Object.fromEntries(requests[1].searchParams), {
    address_id: 'address/1', limit: '8', cursor: '11|thread/1',
  });
});

test('inbox message, thread, and reply detail commands encode resource IDs', async (t) => {
  const urls = [];
  const baseUrl = await startMockServer(t, (request, response) => {
    urls.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url.startsWith('/inbox/messages/')) {
      response.end(JSON.stringify({ success: true, message: { id: 'message/1' } }));
    } else if (request.url.startsWith('/inbox/threads/')) {
      response.end(JSON.stringify({ success: true, thread_id: 'thread/1', messages: [] }));
    } else {
      response.end(JSON.stringify({ success: true, request: { id: 'request/1', status: 'completed' } }));
    }
  });
  await runCli(baseUrl, ['inbox', 'messages', 'show', 'message/1', '--json']);
  await runCli(baseUrl, ['inbox', 'threads', 'show', 'thread/1', '--json']);
  await runCli(baseUrl, ['inbox', 'replies', 'show', 'request/1', '--json']);
  assert.deepEqual(urls, [
    '/inbox/messages/message%2F1',
    '/inbox/threads/thread%2F1',
    '/inbox/replies/request%2F1',
  ]);
});

test('inbox message and thread read-state commands send explicit booleans', async (t) => {
  const received = [];
  const baseUrl = await startMockServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url.includes('/threads/')
      ? { success: true, thread_id: 'thread/1', is_read: false, updated_count: 1 }
      : { success: true, id: 'message/1', is_read: true, changed: true }));
  });
  await runCli(baseUrl, ['inbox', 'messages', 'read-state', 'message/1', '--read', '--json']);
  await runCli(baseUrl, ['inbox', 'threads', 'read-state', 'thread/1', '--unread', '--json']);
  assert.deepEqual(received, [
    { method: 'PATCH', url: '/inbox/messages/message%2F1/read-state', body: { is_read: true } },
    { method: 'PATCH', url: '/inbox/threads/thread%2F1/read-state', body: { is_read: false } },
  ]);
});

test('inbox reply sends files, inline content, and a stable idempotency key', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mailly-cli-reply-'));
  const textPath = join(directory, 'reply.txt');
  const attachmentPath = join(directory, 'report.txt');
  const inlinePath = join(directory, 'logo=image.png');
  await writeFile(textPath, 'Thanks');
  await writeFile(attachmentPath, 'report bytes');
  await writeFile(inlinePath, Buffer.from([0, 1, 2, 255]));
  let received;
  const baseUrl = await startMockServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      url: request.url,
      idempotencyKey: request.headers['idempotency-key'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true, status: 'completed', id: 'reply-1', thread_id: 'thread-1', request_id: 'request-1',
    }));
  });
  const result = await runCli(baseUrl, [
    'inbox', 'messages', 'reply', 'message/with space',
    '--idempotency-key', 'reply-ticket-1',
    '--text-file', textPath,
    '--html', '<p>Thanks <img src="cid:logo-1"></p>',
    '--attachment', attachmentPath,
    '--inline', `logo-1=${inlinePath}`,
    '--json',
  ]);
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/inbox/messages/message%2Fwith%20space/reply');
  assert.equal(received.idempotencyKey, 'reply-ticket-1');
  assert.equal(received.body.text, 'Thanks');
  assert.deepEqual(received.body.attachments, [
    {
      filename: 'report.txt', mimeType: 'text/plain', contentBase64: Buffer.from('report bytes').toString('base64'),
    },
    {
      filename: 'logo=image.png', mimeType: 'image/png', contentBase64: Buffer.from([0, 1, 2, 255]).toString('base64'), contentId: 'logo-1',
    },
  ]);
  assert.equal(JSON.parse(result.stdout).request_id, 'request-1');
  assert.equal(result.stderr, '');
});

test('inbox forward posts to, note, extra attachment, and can omit original attachments', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mailly-cli-forward-'));
  const extraPath = join(directory, 'note.txt');
  await writeFile(extraPath, 'extra bytes');
  let received;
  const baseUrl = await startMockServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      url: request.url,
      idempotencyKey: request.headers['idempotency-key'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true, status: 'completed', id: 'fwd-1', thread_id: 'thread-1',
      to: 'colleague@example.com', request_id: 'request-1',
    }));
  });
  const result = await runCli(baseUrl, [
    'inbox', 'messages', 'forward', 'message/1',
    '--to', 'Colleague@example.com',
    '--text', '帮忙看一下',
    '--no-attachments',
    '--attachment', extraPath,
    '--idempotency-key', 'forward-ticket-1',
    '--json',
  ]);
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/inbox/messages/message%2F1/forward');
  assert.equal(received.idempotencyKey, 'forward-ticket-1');
  assert.equal(received.body.to, 'Colleague@example.com');
  assert.equal(received.body.text, '帮忙看一下');
  assert.equal(received.body.include_attachments, false);
  assert.deepEqual(received.body.attachments, [
    { filename: 'note.txt', mimeType: 'text/plain', contentBase64: Buffer.from('extra bytes').toString('base64') },
  ]);
  assert.equal(JSON.parse(result.stdout).request_id, 'request-1');
  assert.equal(result.stderr, '');
});

test('inbox attachment download writes binary bytes and sanitizes the server filename', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mailly-cli-download-'));
  const bytes = Buffer.from([0, 255, 1]);
  const baseUrl = await startMockServer(t, (request, response) => {
    assert.equal(request.url, '/inbox/messages/message-1/attachments/attachment-1');
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="../../escape.bin"',
    });
    response.end(bytes);
  });
  const result = await execFileAsync(process.execPath, [
    cliBin, '--api-key', 'sk_test', '--base-url', baseUrl,
    'inbox', 'attachments', 'download', 'message-1', 'attachment-1', '--json',
  ], { cwd: directory });
  const output = JSON.parse(result.stdout);
  assert.equal(output.path.endsWith('/escape.bin'), true);
  assert.equal(output.path.includes('../'), false);
  assert.deepEqual(await readFile(output.path), bytes);
});

test('inbox attachment download refuses to overwrite unless --force is explicit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mailly-cli-download-existing-'));
  const outputPath = join(directory, 'existing.bin');
  await writeFile(outputPath, Buffer.from('keep me'));
  const bytes = Buffer.from([9, 8, 7]);
  const baseUrl = await startMockServer(t, (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="download.bin"',
    });
    response.end(bytes);
  });

  let rejected;
  try {
    await runCli(baseUrl, [
      'inbox', 'attachments', 'download', 'message-1', 'attachment-1', outputPath, '--json',
    ]);
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected);
  assert.equal(rejected.stderr, '');
  assert.match(JSON.parse(rejected.stdout).error, /already exists/);
  assert.deepEqual(await readFile(outputPath), Buffer.from('keep me'));

  const forced = await runCli(baseUrl, [
    'inbox', 'attachments', 'download', 'message-1', 'attachment-1', outputPath, '--force', '--json',
  ]);
  assert.equal(JSON.parse(forced.stdout).success, true);
  assert.deepEqual(await readFile(outputPath), bytes);
});

test('parse-time required option failures honor the JSON output contract', async () => {
  let rejected;
  try {
    await execFileAsync(process.execPath, [
      cliBin, 'inbox', 'messages', 'reply', 'message-1', '--text', 'Hello', '--json',
    ], { cwd: cliDirectory });
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected);
  assert.equal(rejected.stderr, '');
  const output = JSON.parse(rejected.stdout);
  assert.equal(output.success, false);
  assert.match(output.error, /--idempotency-key/);
});

test('mailly send exposes attachment and thread fields for a single direct recipient', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mailly-cli-send-'));
  const attachmentPath = join(directory, 'payload.json');
  await writeFile(attachmentPath, '{"ok":true}');
  let body;
  const baseUrl = await startMockServer(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: true, message: 'sent' }));
  });
  await runCli(baseUrl, [
    'send', '--to', 'user@example.com', '--subject', 'Re: Hello', '--from-email', 'agent@example.com',
    '--text', 'Reply', '--attachment', attachmentPath,
    '--message-id', '<new@example.com>', '--in-reply-to', '<old@example.com>',
    '--reference', '<root@example.com>', '--reference', '<old@example.com>', '--json',
  ]);
  assert.equal(body.messageId, '<new@example.com>');
  assert.equal(body.inReplyTo, '<old@example.com>');
  assert.deepEqual(body.references, ['<root@example.com>', '<old@example.com>']);
  assert.deepEqual(body.attachments, [{
    filename: 'payload.json', mimeType: 'application/json', contentBase64: Buffer.from('{"ok":true}').toString('base64'),
  }]);
});
