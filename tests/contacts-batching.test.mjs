import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chunkCsv, chunkItems, resolveChunkSize, splitCsvRecords } from '../dist/batching.js';
import { createProgram } from '../dist/index.js';

test('chunkItems splits an oversized list into equal batches', () => {
  assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkItems([], 2), []);
});

test('resolveChunkSize defaults and rejects unusable sizes', () => {
  assert.equal(resolveChunkSize(undefined), 100);
  assert.equal(resolveChunkSize(25), 25);
  assert.throws(() => resolveChunkSize(0), /between 1 and 500/);
  assert.throws(() => resolveChunkSize(501), /between 1 and 500/);
});

test('CSV records keep quoted newlines in one row', () => {
  const csv = 'external_id,email,name\ncrm-1,a@example.com,"Ada\nLovelace"\ncrm-2,b@example.com,Bob\n';
  assert.deepEqual(splitCsvRecords(csv), [
    'external_id,email,name',
    'crm-1,a@example.com,"Ada\nLovelace"',
    'crm-2,b@example.com,Bob',
  ]);
  const chunks = chunkCsv(csv, 1);
  assert.deepEqual(chunks.map((chunk) => chunk.rows), [1, 1]);
  assert.equal(chunks[0].csv, 'external_id,email,name\ncrm-1,a@example.com,"Ada\nLovelace"\n');
  assert.equal(chunks[1].csv, 'external_id,email,name\ncrm-2,b@example.com,Bob\n');
});

async function stubServer(handler) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const result = handler(request, body);
    response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function captureStdout() {
  const written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  return { written, restore: () => { process.stdout.write = original; } };
}

test('contacts batch splits a large file across requests and keeps global indices', async (t) => {
  const requests = [];
  const { server, baseUrl } = await stubServer((_request, body) => {
    const { contacts } = JSON.parse(body);
    requests.push(contacts.length);
    return {
      body: {
        success: true,
        received: contacts.length,
        succeeded: contacts.length - 1,
        failed: 1,
        // Fail the last item of every batch to check that index maps back to the global position
        results: [{ index: contacts.length - 1, success: false, error: 'email is invalid.' }],
      },
    };
  });
  t.after(() => server.close());

  const contacts = Array.from({ length: 5 }, (_, index) => ({
    externalId: `crm-${index}`,
    email: `user${index}@example.com`,
  }));
  const file = new URL('./fixtures-contacts.json', import.meta.url);
  await (await import('node:fs/promises')).writeFile(file, JSON.stringify(contacts), 'utf8');
  t.after(async () => (await import('node:fs/promises')).unlink(file));

  const capture = captureStdout();
  try {
    await createProgram().parseAsync([
      'node', 'mailly', '--json', '--api-key', 'test-key', '--base-url', baseUrl,
      'contacts', 'batch', '--file', file.pathname, '--chunk-size', '2',
    ]);
  } finally {
    capture.restore();
  }

  assert.deepEqual(requests, [2, 2, 1], 'the CLI submits safe-sized chunks instead of one huge request');
  const output = JSON.parse(capture.written.join(''));
  assert.equal(output.received, 5);
  assert.equal(output.succeeded, 2);
  assert.equal(output.failed, 3);
  assert.equal(output.chunks, 3);
  assert.deepEqual(output.results.map((result) => result.index), [1, 3, 4]);
});

test('contacts import chunks CSV rows and reports original row numbers', async (t) => {
  const requests = [];
  const { server, baseUrl } = await stubServer((_request, body) => {
    requests.push(body);
    return {
      body: {
        success: false,
        received: 1,
        succeeded: 0,
        failed: 1,
        results: [{ row: 2, success: false, error: 'email is invalid.' }],
      },
    };
  });
  t.after(() => server.close());

  const file = new URL('./fixtures-contacts.csv', import.meta.url);
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    file,
    'external_id,email\ncrm-1,a@example.com\ncrm-2,b@example.com\ncrm-3,c@example.com\n',
    'utf8',
  );
  t.after(async () => fs.unlink(file));

  const capture = captureStdout();
  try {
    await createProgram().parseAsync([
      'node', 'mailly', '--json', '--api-key', 'test-key', '--base-url', baseUrl,
      'contacts', 'import', file.pathname, '--chunk-size', '1',
    ]);
  } finally {
    capture.restore();
  }

  assert.equal(requests.length, 3);
  for (const csv of requests) assert.match(csv, /^external_id,email\n/, 'every chunk keeps the header');
  const output = JSON.parse(capture.written.join(''));
  assert.deepEqual(output.results.map((result) => result.row), [2, 3, 4]);
});
