// In-process tests: the official MCP client SDK talks to createServer() over an
// in-memory transport, with a fake GitHub client. Covers tool discovery,
// structured output (validated by the client against the declared outputSchema),
// and how each GitHub failure becomes a tool error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer, errorKind } from '../src/server.js';
import { GitHubError } from '../src/github.js';
import { EXPECTED_INFO, PLANTED_SECRET, ALNUM_SECRET_NAME } from './fixtures/github.js';

async function connect(github) {
  const logs = [];
  const server = createServer({ github, log: (m) => logs.push(m) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'server-test', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, logs, close: () => client.close() };
}

const okGitHub = { getRepository: async () => ({ ...EXPECTED_INFO }) };

test('tools/list exposes get_repository with input and output schemas', async () => {
  const { client, close } = await connect(okGitHub);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['get_repository']);
  const tool = tools[0];
  assert.deepEqual(tool.inputSchema.required.sort(), ['owner', 'repo']);
  assert.ok(tool.outputSchema, 'outputSchema should be advertised');
  assert.equal(tool.annotations.readOnlyHint, true);
  await close();
});

test('success returns structuredContent plus a JSON text copy', async () => {
  const { client, close } = await connect(okGitHub);
  const result = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'hello-world' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, EXPECTED_INFO);
  assert.deepEqual(JSON.parse(result.content[0].text), EXPECTED_INFO);
  await close();
});

test('invalid arguments are rejected before the GitHub client is called', async () => {
  let called = 0;
  const { client, close } = await connect({ getRepository: async () => (called++, EXPECTED_INFO) });
  const badArgs = [{}, { owner: 'octo-org' }, { owner: 'octo-org', repo: 42 }, { owner: '../x', repo: 'y' }, { owner: 'a', repo: '..' }];
  for (const args of badArgs) {
    const result = await client.callTool({ name: 'get_repository', arguments: args });
    assert.equal(result.isError, true, `expected isError for ${JSON.stringify(args)}`);
    assert.match(result.content[0].text, /Input validation error/);
  }
  assert.equal(called, 0);
  await close();
});

test('each GitHubError becomes an isError result with its message', async () => {
  const codes = ['not_found', 'not_public', 'redirected', 'rate_limited', 'unauthorized', 'forbidden', 'upstream_error', 'malformed_response', 'network_error', 'timeout'];
  for (const code of codes) {
    const { client, logs, close } = await connect({
      getRepository: async () => {
        throw new GitHubError(code, `message for ${code}`);
      },
    });
    const result = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'hello-world' } });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, `message for ${code}`);
    assert.equal(result.structuredContent, undefined);
    assert.match(logs[0], new RegExp(code));
    await close();
  }
});

test('an unexpected exception carrying a secret: generic output, secret in neither output nor log', async () => {
  const SECRET = PLANTED_SECRET;
  const { client, logs, close } = await connect({
    getRepository: async () => {
      const err = new Error(`token=${SECRET} upstream said: ${SECRET}`);
      err.stack = `Error: ${SECRET}\n    at somewhere (${SECRET}.js:1:1)`;
      throw err;
    },
  });
  const result = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'hello-world' } });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Internal error while fetching repository metadata.');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /failed unexpectedly \(Error\)/);
  assert.ok(!JSON.stringify(result).includes(SECRET), 'secret in tool output');
  assert.ok(!logs.join('\n').includes(SECRET), 'secret in log');
  await close();
});

test('an exception with an alphanumeric, non-allowlisted name is logged as "unknown error"', async () => {
  assert.match(ALNUM_SECRET_NAME, /^[A-Za-z][A-Za-z0-9]{0,39}$/, 'fixture must pass the old regex');
  const { client, logs, close } = await connect({
    getRepository: async () => {
      const err = new Error('x');
      err.name = ALNUM_SECRET_NAME;
      throw err;
    },
  });
  const result = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'hello-world' } });
  assert.match(logs[0], /failed unexpectedly \(unknown error\)$/);
  assert.ok(!logs.join('\n').includes(ALNUM_SECRET_NAME), 'secret in log');
  assert.ok(!JSON.stringify(result).includes(ALNUM_SECRET_NAME), 'secret in tool output');
  await close();
});

test('errorKind: only allowlisted built-in names pass through', () => {
  assert.equal(errorKind(new TypeError('x')), 'TypeError');
  assert.equal(errorKind(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'TimeoutError');
  assert.equal(errorKind(Object.assign(new Error('x'), { name: ALNUM_SECRET_NAME })), 'unknown error');
  assert.equal(errorKind('a string'), 'unknown error');
  assert.equal(errorKind(null), 'unknown error');
});

test('an exception whose name is not a plain identifier is logged as "unknown error"', async () => {
  const SECRET = PLANTED_SECRET;
  const { client, logs, close } = await connect({
    getRepository: async () => {
      const err = new Error('x');
      err.name = `Weird ${SECRET}`;
      throw err;
    },
  });
  await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'hello-world' } });
  assert.match(logs[0], /\(unknown error\)/);
  assert.ok(!logs[0].includes(SECRET));
  await close();
});
