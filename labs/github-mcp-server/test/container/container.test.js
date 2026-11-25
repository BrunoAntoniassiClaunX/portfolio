// Container tests: run the built image with Docker and talk to it with the
// official MCP client over stdio (`docker run -i`), as an MCP host would.
// Requires a running Docker daemon and the image:
//   docker build -t github-mcp-server:local .
//   npm run test:container
//
// Offline and deterministic: the container runs with `--network none`, and the
// fake GitHub API from test/fixtures is mounted read-only and preloaded via
// NODE_OPTIONS. Nothing test-related is baked into the image.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { EXPECTED_INFO, PLANTED_SECRET, ALNUM_SECRET_CODE, ALNUM_SECRET_NAME } from '../fixtures/github.js';

const run = promisify(execFile);
const IMAGE = process.env.MCP_IMAGE ?? 'github-mcp-server:local';
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

// Arguments that run the image offline with the fake GitHub API.
function offlineRunArgs(extra = []) {
  return [
    'run', '-i', '--rm',
    '--network', 'none',
    '-v', `${FIXTURES}:/fixtures:ro`,
    '-e', 'NODE_OPTIONS=--import=/fixtures/fake-github-preload.js',
    ...extra,
    IMAGE,
  ];
}

const docker = (...args) => run('docker', args, { timeout: 60_000 });

// Remove any named container a failed test left behind.
const named = new Set();
after(async () => {
  for (const name of named) await docker('rm', '-f', name).catch(() => {});
});

async function connect(clientOptions = {}, extraRunArgs = []) {
  const transport = new StdioClientTransport({
    command: 'docker',
    args: offlineRunArgs(extraRunArgs),
    env: getDefaultEnvironment(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'container-test', version: '0.0.0' }, clientOptions);
  await client.connect(transport);
  return { client, transport };
}

test('image config: non-root user, no exposed ports, exec-form entrypoint, no token in env', async () => {
  const { stdout } = await docker('image', 'inspect', IMAGE, '--format', '{{json .Config}}');
  const config = JSON.parse(stdout);
  assert.equal(config.User, 'node');
  assert.equal(config.ExposedPorts ?? null, null);
  assert.deepEqual(config.Entrypoint, ['node', 'src/index.js']);
  assert.equal(config.Cmd ?? null, null, 'base image CMD must not be appended to the entrypoint');
  assert.ok(!config.Env.some((e) => e.startsWith('GITHUB_TOKEN')), 'no token baked into the image');
});

test('runtime user: uid 1000 (node), and application files are read-only to it', async () => {
  const { stdout } = await docker(
    'run', '--rm', '--network', 'none', '--entrypoint', 'sh', IMAGE, '-c',
    'id -u; id -un; if touch /app/src/x 2>/dev/null; then echo writable; else echo read-only; fi',
  );
  assert.deepEqual(stdout.trim().split('\n'), ['1000', 'node', 'read-only']);
});

test('image contents: only production files; no tests, dev dependencies, .env or secrets', async () => {
  const { stdout } = await docker(
    'run', '--rm', '--network', 'none', '--entrypoint', 'sh', IMAGE, '-c',
    'ls -A /app; echo ---; ls /app/node_modules/@modelcontextprotocol; echo ---; ' +
      `grep -rlF -e '${PLANTED_SECRET}' -e '${ALNUM_SECRET_CODE}' -e '${ALNUM_SECRET_NAME}' -e fake-github-preload /app || echo no-matches`,
  );
  const [appEntries, mcpPackages, secretScan] = stdout.trim().split('\n---\n');
  assert.deepEqual(appEntries.split('\n').sort(), ['node_modules', 'package-lock.json', 'package.json', 'src']);
  assert.deepEqual(mcpPackages.split('\n').sort(), ['core', 'server'], 'dev-only client package must be absent');
  assert.equal(secretScan.trim(), 'no-matches');
});

for (const [label, options, expectedVersion] of [
  ['default (2025 handshake)', {}, '2025-11-25'],
  ['pinned 2026-07-28', { versionNegotiation: { mode: { pin: '2026-07-28' } } }, '2026-07-28'],
]) {
  test(`official client over docker run -i, ${label}: negotiate, list, call, errors`, async () => {
    const { client } = await connect(options);
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), expectedVersion);
      assert.equal(client.getServerVersion()?.name, 'github-mcp-server');

      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ['get_repository']);

      // structuredContent is validated by the client against the outputSchema.
      const ok = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'hello-world' } });
      assert.deepEqual(ok.structuredContent, EXPECTED_INFO);

      const missing = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'missing' } });
      assert.equal(missing.isError, true);

      const invalid = await client.callTool({ name: 'get_repository', arguments: { owner: '../x', repo: 'y' } });
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
    }
  });
}

test('secrets planted in failures appear in neither tool output nor container stderr', async () => {
  const { client, transport } = await connect();
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += chunk));
  const results = [];
  try {
    for (const repo of ['explode', 'network-secret', 'alnum-network', 'alnum-explode']) {
      results.push(await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo } }));
    }
  } finally {
    await client.close();
  }
  for (const r of results) assert.equal(r.isError, true);
  const everything = JSON.stringify(results) + stderr;
  for (const secret of [PLANTED_SECRET, ALNUM_SECRET_CODE, ALNUM_SECRET_NAME]) {
    assert.ok(!everything.includes(secret), `secret leaked: ${secret}`);
  }
  assert.match(stderr, /failed unexpectedly/, 'stderr should have been captured');
});

test('docker stop: SIGTERM reaches node as PID 1 and the container exits 0 without being killed', async () => {
  const name = `github-mcp-server-stop-test-${process.pid}`;
  named.add(name);
  // Detached with stdin held open (-i), so the server keeps waiting for input.
  await docker('run', '-d', '-i', '--name', name, '--network', 'none', IMAGE);
  // Wait for the readiness line, which is logged after the signal handlers are
  // installed. A SIGTERM before that is ignored by PID 1 (see README).
  for (let i = 0; i < 40; i++) {
    const { stderr } = await docker('logs', name);
    if (stderr.includes('listening on stdio')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const started = Date.now();
  await docker('stop', '--time', '10', name);
  const elapsed = Date.now() - started;
  const { stdout } = await docker('inspect', name, '--format', '{{.State.ExitCode}} {{.State.OOMKilled}}');
  const { stdout: logs } = await docker('logs', name);
  const { stderr: logErr } = await docker('logs', name);
  await docker('rm', name);
  named.delete(name);

  assert.equal(stdout.trim(), '0 false', 'exit code 0 means our SIGTERM handler ran (137 would mean SIGKILL)');
  assert.ok(elapsed < 8000, `stop took ${elapsed} ms; near 10 s would mean the signal was ignored`);
  assert.equal(logs, '', 'nothing on stdout');
  assert.match(logErr, /SIGTERM received, shutting down/);
});

test('stdin EOF: closing the client ends the container and --rm removes it', async () => {
  const name = `github-mcp-server-eof-test-${process.pid}`;
  named.add(name);
  const { client } = await connect({}, ['--name', name]);
  const { stdout: running } = await docker('ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}');
  assert.equal(running.trim(), name);
  await client.close();
  // Give Docker a moment to finish removing the container.
  let remaining = name;
  for (let i = 0; i < 20 && remaining; i++) {
    await new Promise((r) => setTimeout(r, 250));
    remaining = (await docker('ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}')).stdout.trim();
  }
  assert.equal(remaining, '', 'container should be gone after stdin closed');
  named.delete(name);
});
