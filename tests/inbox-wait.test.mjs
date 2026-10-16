import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const cliDirectory = fileURLToPath(new URL('..', import.meta.url));
const cliBin = fileURLToPath(new URL('../bin/mailly.mjs', import.meta.url));
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Serves /inbox/messages from listFor(pollNumber) and /inbox/messages/:id/content from bodies.
async function startInbox(t, { listFor, bodies = {} }) {
  const requests = [];
  let polls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/inbox/messages') {
      polls += 1;
      const result = listFor(polls);
      if (result.status) return send(result.status, { success: false, error: result.error });
      return send(200, { success: true, messages: result, cursor: null });
    }
    const content = /^\/inbox\/messages\/([^/]+)\/content$/.exec(url.pathname);
    if (content && bodies[content[1]]) {
      return send(200, { success: true, content: { id: content[1], has_html: Boolean(bodies[content[1]].html), ...bodies[content[1]] } });
    }
    return send(404, { success: false, error: 'Not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, polls: () => polls };
}

function runCli(baseUrl, args) {
  return execFileAsync(process.execPath, [cliBin, '--api-key', 'sk_test', '--base-url', baseUrl, ...args], { cwd: cliDirectory });
}

async function runCliExpectingExit(baseUrl, args) {
  try {
    await runCli(baseUrl, args);
  } catch (error) {
    return error;
  }
  assert.fail(`expected mailly ${args.join(' ')} to exit non-zero`);
}

function message(id, fields) {
  return {
    id, thread_id: `thread-${id}`, address_id: 'address-1', to_address: 'agent@mailly.site', is_read: false,
    direction: 'inbound', from_name: null, received_at: nowSeconds(), ...fields,
  };
}

test('inbox wait --extract code skips matching mail without a code and prints the newest code as JSON', async (t) => {
  const recent = nowSeconds() - 60;
  const inbox = await startInbox(t, {
    listFor: () => [
      message('welcome', { from_address: 'hello@github.com', subject: 'Welcome to GitHub', received_at: recent + 5 }),
      message('lookalike', { from_address: 'noreply@github.com.attacker.example', subject: 'Your code', received_at: recent + 4 }),
      message('reply', { from_address: 'noreply@github.com', subject: 'Re: code', direction: 'outbound', received_at: recent + 3 }),
      message('launch', { from_address: 'noreply@github.com', from_name: 'GitHub', subject: 'Your GitHub launch code', received_at: recent }),
    ],
    bodies: {
      welcome: { text: 'Thanks for joining GitHub! Explore https://github.com/explore.' },
      lookalike: { text: 'Your code is 111111' },
      reply: { text: 'Code 222222' },
      launch: { text: "Here's your GitHub launch code, @octocat!\n\n58293017\n\nContinue signing up by entering the code above." },
    },
  });
  const before = nowSeconds();
  const { stdout } = await runCli(inbox.baseUrl, [
    'inbox', 'wait', '--from', 'github.com', '--extract', 'code', '--since', '10m', '--timeout', '5s', '--json',
  ]);
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {
    success: true,
    message_id: 'launch',
    thread_id: 'thread-launch',
    from: 'noreply@github.com',
    to: 'agent@mailly.site',
    subject: 'Your GitHub launch code',
    received_at: new Date(recent * 1000).toISOString(),
    code: '58293017',
  });
  const [list, ...contents] = inbox.requests;
  assert.equal(list.path, '/inbox/messages');
  assert.equal(list.query.sender, 'github.com');
  assert.equal(list.query.match, 'fuzzy');
  assert.equal(list.query.limit, '50');
  assert.ok(Math.abs(Number(list.query.since) - (before - 600)) <= 2);
  // Only matching inbound mail is opened, without a format so both text and HTML come back.
  assert.deepEqual(contents, [
    { path: '/inbox/messages/welcome/content', query: {} },
    { path: '/inbox/messages/launch/content', query: {} },
  ]);
});

test('mailly wait prints only the extracted link in text mode', async (t) => {
  const inbox = await startInbox(t, {
    listFor: () => [message('verify', { from_address: 'noreply@acme.example', subject: 'Confirm your email' })],
    bodies: {
      verify: {
        text: null,
        html: '<a href="https://acme.example/unsubscribe?u=1">Unsubscribe</a>'
          + '<a href="https://app.acme.example/verify?token=AbCdEf0123456789xyz&amp;u=1">Confirm email</a>',
      },
    },
  });
  const { stdout, stderr } = await runCli(inbox.baseUrl, ['wait', '--subject', 'confirm', '--extract', 'link', '--since', '1m']);
  assert.equal(stdout, 'https://app.acme.example/verify?token=AbCdEf0123456789xyz&u=1\n');
  assert.equal(stderr, '');
  assert.equal(inbox.requests[0].query.subject, 'confirm');
});

test('inbox wait defaults to new mail only and keeps polling until it arrives', async (t) => {
  const inbox = await startInbox(t, {
    listFor: (poll) => [
      ...(poll >= 2 ? [message('new', { from_address: 'bot@service.example', subject: 'Hello' })] : []),
      message('old', { from_address: 'bot@service.example', subject: 'Older', received_at: nowSeconds() - 120 }),
    ],
  });
  const { stdout } = await runCli(inbox.baseUrl, ['inbox', 'wait', '--interval', '1s', '--timeout', '10s', '--json']);
  assert.equal(JSON.parse(stdout).message_id, 'new');
  assert.ok(inbox.polls() >= 2);
  assert.equal(inbox.requests[0].query.match, undefined);
});

test('inbox wait retries transient API errors and fails fast on others', async (t) => {
  const flaky = await startInbox(t, {
    listFor: (poll) => (poll === 1 ? { status: 503, error: 'Unavailable' } : [message('m1', { from_address: 'a@b.example' })]),
  });
  const { stdout } = await runCli(flaky.baseUrl, ['inbox', 'wait', '--interval', '1s', '--timeout', '10s', '--json']);
  assert.equal(JSON.parse(stdout).message_id, 'm1');

  const unauthorized = await startInbox(t, { listFor: () => ({ status: 401, error: 'Invalid API key' }) });
  const error = await runCliExpectingExit(unauthorized.baseUrl, ['inbox', 'wait', '--timeout', '30s', '--json']);
  assert.equal(error.code, 1);
  assert.deepEqual(JSON.parse(error.stdout), { success: false, error: 'API error (401): Invalid API key' });
  assert.equal(unauthorized.polls(), 1);
});

test('inbox wait exits 2 on timeout and 3 when matching mail has nothing to extract', async (t) => {
  const empty = await startInbox(t, { listFor: () => [] });
  const timeout = await runCliExpectingExit(empty.baseUrl, [
    'inbox', 'wait', '--from', 'github.com', '--timeout', '1s', '--interval', '1s', '--json',
  ]);
  assert.equal(timeout.code, 2);
  assert.deepEqual(JSON.parse(timeout.stdout), {
    success: false, error: 'Timed out after 1s waiting for mail from github.com', reason: 'timeout',
  });

  const received = nowSeconds();
  const noCode = await startInbox(t, {
    listFor: () => [message('welcome', { from_address: 'hello@github.com', subject: 'Welcome', received_at: received })],
    bodies: { welcome: { text: 'Welcome aboard!' } },
  });
  const notExtractable = await runCliExpectingExit(noCode.baseUrl, [
    'inbox', 'wait', '--from', 'github.com', '--extract', 'code', '--since', '1m', '--timeout', '1s', '--interval', '1s', '--json',
  ]);
  assert.equal(notExtractable.code, 3);
  const body = JSON.parse(notExtractable.stdout);
  assert.equal(body.success, false);
  assert.equal(body.reason, 'not_extractable');
  assert.equal(body.message_id, 'welcome');
  assert.match(body.error, /mailly inbox messages content welcome/);
  // The message body is fetched once, not on every poll.
  assert.equal(noCode.requests.filter((request) => request.path.endsWith('/content')).length, 1);

  const pretty = await runCliExpectingExit(empty.baseUrl, ['inbox', 'wait', '--timeout', '1s']);
  assert.equal(pretty.code, 2);
  assert.equal(pretty.stdout, '');
  assert.match(pretty.stderr, /Timed out after 1s waiting for new mail/);
});

test('inbox wait rejects invalid options before calling the API', async (t) => {
  const inbox = await startInbox(t, { listFor: () => [] });
  for (const args of [
    ['--extract', 'otp'],
    ['--interval', '200ms'],
    ['--timeout', '0'],
    ['--since', 'yesterday'],
  ]) {
    const error = await runCliExpectingExit(inbox.baseUrl, ['inbox', 'wait', ...args, '--json']);
    assert.equal(error.code, 1, args.join(' '));
  }
  assert.equal(inbox.requests.length, 0);
});
