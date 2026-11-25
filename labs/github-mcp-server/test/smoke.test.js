// Protocol smoke test: spawns the real server (src/index.js) as a child
// process and talks raw JSON-RPC over its stdin/stdout, the way an MCP host does.
// GitHub is faked inside the child via `node --import`, so no network is used.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXPECTED_INFO, PLANTED_SECRET, ALNUM_SECRET_CODE, ALNUM_SECRET_NAME } from './fixtures/github.js';

const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL('./fixtures/fake-github-preload.js', import.meta.url));
const TIMEOUT_MS = 5000;

// If a test fails before closing its server, kill the child here so the
// test run reports the failure instead of hanging on an open process.
const children = new Set();
afterEach(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
});

// Starts the server and returns helpers to send messages and collect replies.
function startServer(env = {}) {
  const child = spawn(process.execPath, ['--import', FAKE_GITHUB, SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, ...env },
  });
  children.add(child);
  const stdoutLines = [];
  const waiters = new Map(); // JSON-RPC id -> resolve
  let buffer = '';
  let stderr = '';

  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      stdoutLines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // recorded in stdoutLines; the purity check reports it
      }
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    stdoutLines,
    exited,
    getStderr: () => stderr,
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params && { params }) }) + '\n');
    },
    request(id, method, params) {
      const reply = new Promise((resolve, reject) => {
        waiters.set(id, resolve);
        setTimeout(() => reject(new Error(`no response to ${method} (id ${id})`)), TIMEOUT_MS).unref();
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) }) + '\n');
      return reply;
    },
    async end() {
      child.stdin.end();
      return withTimeout(exited, 'exit after stdin EOF');
    },
  };
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), TIMEOUT_MS).unref()),
  ]);
}

// Every line on stdout must be a JSON-RPC 2.0 message; nothing else is allowed.
function assertStdoutIsProtocolOnly(lines) {
  assert.ok(lines.length > 0, 'expected some stdout output');
  for (const line of lines) {
    let msg;
    assert.doesNotThrow(() => (msg = JSON.parse(line)), `non-JSON line on stdout: ${line}`);
    assert.equal(msg.jsonrpc, '2.0', `not a JSON-RPC 2.0 message: ${line}`);
  }
}

const CLIENT_INFO = { name: 'smoke-test', version: '0.0.0' };
const call = (repo, owner = 'octo-org') => ({ name: 'get_repository', arguments: { owner, repo } });

test('2025-11-25: handshake, discovery, success, GitHub errors, invalid input, clean exit', async () => {
  const s = startServer();

  // 1. Initialization: client proposes a version, server answers with the one it will use.
  const init = await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal(init.result.serverInfo.name, 'github-mcp-server');
  assert.ok(init.result.capabilities.tools, 'server must advertise the tools capability');
  s.notify('notifications/initialized'); // required by the spec before normal requests

  // 2. Tool discovery.
  const list = await s.request(2, 'tools/list');
  const tool = list.result.tools.find((t) => t.name === 'get_repository');
  assert.ok(tool, 'get_repository should be listed');
  assert.deepEqual(tool.inputSchema.required.sort(), ['owner', 'repo']);
  assert.ok(tool.outputSchema);

  // 3. Valid execution with structured output.
  const ok = await s.request(3, 'tools/call', call('hello-world'));
  assert.equal(ok.result.isError, undefined);
  assert.deepEqual(ok.result.structuredContent, EXPECTED_INFO);

  // 4. GitHub failures arrive as tool errors (isError), not protocol errors.
  const missing = await s.request(4, 'tools/call', call('missing'));
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /not found/);
  const limited = await s.request(5, 'tools/call', call('rate-limited'));
  assert.match(limited.result.content[0].text, /rate limit/);
  const upstream = await s.request(6, 'tools/call', call('server-error'));
  assert.match(upstream.result.content[0].text, /HTTP 500/);

  // 5. Invalid input is rejected by the SDK before the handler runs.
  for (const [i, args] of [{ owner: 'octo-org' }, { owner: 'octo-org', repo: 7 }, { owner: 'x', repo: '../etc' }].entries()) {
    const bad = await s.request(10 + i, 'tools/call', { name: 'get_repository', arguments: args });
    assert.equal(bad.result.isError, true, `expected isError for ${JSON.stringify(args)}`);
    assert.match(bad.result.content[0].text, /Input validation error/);
  }

  // 6. Unknown tool (the old M1 `echo`) is a JSON-RPC protocol error, not a tool result.
  const unknown = await s.request(20, 'tools/call', { name: 'echo', arguments: { message: 'hi' } });
  assert.equal(unknown.error?.code, -32602);
  assert.equal(unknown.result, undefined);

  // 7. Clean termination on stdin EOF.
  const { code, signal } = await s.end();
  assert.equal(code, 0);
  assert.equal(signal, null);
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

test('2025 handshake: unsupported client version gets a server-supported version back', async () => {
  const s = startServer();
  const init = await s.request(1, 'initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: CLIENT_INFO });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal((await s.end()).code, 0);
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

// 2026-07-28 revision: no initialize handshake. Each request carries a _meta
// envelope with the protocol version, client info and client capabilities.
function envelope(version = '2026-07-28') {
  return {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

test('2026-07-28: server/discover, discovery, success, invalid input, clean exit', async () => {
  const s = startServer();
  const discover = await s.request(1, 'server/discover', { _meta: envelope() });
  assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
  assert.ok(discover.result.capabilities.tools);

  const list = await s.request(2, 'tools/list', { _meta: envelope() });
  assert.ok(list.result.tools.some((t) => t.name === 'get_repository'));

  const ok = await s.request(3, 'tools/call', { ...call('hello-world'), _meta: envelope() });
  assert.deepEqual(ok.result.structuredContent, EXPECTED_INFO);

  const bad = await s.request(4, 'tools/call', { name: 'get_repository', arguments: {}, _meta: envelope() });
  assert.equal(bad.result.isError, true);

  assert.equal((await s.end()).code, 0);
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

test('2026-07-28: an unsupported envelope version is rejected with a JSON-RPC error', async () => {
  const s = startServer();
  const reply = await s.request(1, 'server/discover', { _meta: envelope('2099-01-01') });
  assert.equal(reply.error?.code, -32022);
  assert.equal(reply.result, undefined);
  assert.equal((await s.end()).code, 0);
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

test('timeout: GITHUB_TIMEOUT_MS bounds a hanging GitHub request', async () => {
  const s = startServer({ GITHUB_TIMEOUT_MS: '300' });
  await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO });
  s.notify('notifications/initialized');
  const started = Date.now();
  const reply = await s.request(2, 'tools/call', call('slow'));
  const elapsed = Date.now() - started;
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /did not respond within 300 ms/);
  assert.ok(elapsed >= 280 && elapsed < 3000, `answered after ${elapsed} ms`);
  assert.equal((await s.end()).code, 0);
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

test('token: GITHUB_TOKEN is used but never appears on stdout or stderr', async () => {
  const TOKEN = 'fake-test-token-should-never-be-printed';
  // The fake API only accepts a different token, so this call fails with 401.
  const s = startServer({ GITHUB_TOKEN: TOKEN, FAKE_GITHUB_ACCEPTED_TOKEN: 'another-token' });
  await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO });
  s.notify('notifications/initialized');
  const reply = await s.request(2, 'tools/call', call('hello-world'));
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /rejected the configured GITHUB_TOKEN/);
  assert.equal((await s.end()).code, 0);

  const everything = s.stdoutLines.join('\n') + s.getStderr();
  assert.ok(!everything.includes(TOKEN), 'token leaked into output');
  assert.match(s.getStderr(), /GitHub auth: token/);
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

test('redirect: a renamed repository is refused, not followed (checked at request time)', async () => {
  // The fake API follows to another origin unless the request says redirect: 'error'.
  const s = startServer();
  await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO });
  s.notify('notifications/initialized');
  const reply = await s.request(2, 'tools/call', call('renamed'));
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /redirected .*current owner and name/);
  assert.ok(!JSON.stringify(reply).includes('elsewhere'), 'redirect target must not be followed');
  assert.equal((await s.end()).code, 0);
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

test('public-only: an authenticated request for a private repository is refused', async () => {
  const TOKEN = 'fake-accepted-test-token';
  const s = startServer({ GITHUB_TOKEN: TOKEN, FAKE_GITHUB_ACCEPTED_TOKEN: TOKEN });
  await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO });
  s.notify('notifications/initialized');
  const reply = await s.request(2, 'tools/call', call('secret-repo'));
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /is not public/);
  assert.equal(reply.result.structuredContent, undefined);
  // The public repository still works with the same token.
  const ok = await s.request(3, 'tools/call', call('hello-world'));
  assert.deepEqual(ok.result.structuredContent, EXPECTED_INFO);
  assert.equal((await s.end()).code, 0);
  assert.ok(!s.stdoutLines.join('\n').includes('PRIVATE-DESCRIPTION'), 'private metadata leaked');
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

test('secrets inside failures appear in neither tool output nor stderr', async () => {
  const s = startServer();
  await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO });
  s.notify('notifications/initialized');

  // Unexpected exception thrown while reading the response.
  const explode = await s.request(2, 'tools/call', call('explode'));
  assert.equal(explode.result.isError, true);
  assert.equal(explode.result.content[0].text, 'Internal error while fetching repository metadata.');

  // Network failure whose message and error code carry the secret.
  const network = await s.request(3, 'tools/call', call('network-secret'));
  assert.equal(network.result.content[0].text, 'Could not reach the GitHub API (unknown error).');

  // Alphanumeric secrets that would have passed the earlier regex filters.
  const alnumNetwork = await s.request(4, 'tools/call', call('alnum-network'));
  assert.equal(alnumNetwork.result.content[0].text, 'Could not reach the GitHub API (unknown error).');
  const alnumExplode = await s.request(5, 'tools/call', call('alnum-explode'));
  assert.equal(alnumExplode.result.content[0].text, 'Internal error while fetching repository metadata.');

  assert.equal((await s.end()).code, 0);
  assert.match(s.getStderr(), /failed unexpectedly \(Error\)/);
  assert.match(s.getStderr(), /failed unexpectedly \(unknown error\)/);
  const out = s.stdoutLines.join('\n');
  for (const secret of [PLANTED_SECRET, ALNUM_SECRET_CODE, ALNUM_SECRET_NAME]) {
    assert.ok(!out.includes(secret), `secret on stdout: ${secret}`);
    assert.ok(!s.getStderr().includes(secret), `secret on stderr: ${secret}`);
  }
  assertStdoutIsProtocolOnly(s.stdoutLines);
});

test('SIGTERM shuts the server down with exit code 0', async () => {
  const s = startServer();
  await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO });
  s.child.kill('SIGTERM');
  const { code } = await withTimeout(s.exited, 'exit after SIGTERM');
  assert.equal(code, 0);
  assert.match(s.getStderr(), /SIGTERM received/);
  assertStdoutIsProtocolOnly(s.stdoutLines);
});
