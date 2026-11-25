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
    'ls -A /app; echo ---; ls -A /app/src; echo ---; ls /app/node_modules/@modelcontextprotocol',
  );
  const [appEntries, srcEntries, mcpPackages] = stdout.trim().split('\n---\n');
  assert.deepEqual(appEntries.split('\n').sort(), ['node_modules', 'package-lock.json', 'package.json', 'src']);
  assert.deepEqual(srcEntries.split('\n').sort(), ['github.js', 'index.js', 'server.js']);
  assert.deepEqual(mcpPackages.split('\n').sort(), ['core', 'server'], 'dev-only client package must be absent');
});

test('image secret scan: grep finds no planted secrets (exit 1), and a grep error fails the test', async () => {
  // grep exits 0 when it finds a match, 1 when it finds none, 2 on an error.
  // Only exit 1 means "absent", so the exit code is checked, not the output.
  // The trailing echo prints grep's real exit code on the last line (and makes
  // the shell exit 0, so execFile still returns stdout).
  // Alpine's BusyBox grep can report a per-file read error on stderr and still
  // exit 1, so stderr must also be empty for the scan to count.
  const scan = `grep -rlF -e '${PLANTED_SECRET}' -e '${ALNUM_SECRET_CODE}' -e '${ALNUM_SECRET_NAME}' -e fake-github-preload /app`;
  const { stdout, stderr } = await docker(
    'run', '--rm', '--network', 'none', '--entrypoint', 'sh', IMAGE, '-c',
    `${scan}; echo "grep-exit=$?"`,
  );
  const lines = stdout.trim().split('\n');
  assert.equal(lines.at(-1), 'grep-exit=1', `grep must report "no match"; got: ${stdout.trim()}`);
  assert.deepEqual(lines.slice(0, -1), [], 'no file may contain a planted secret');
  assert.equal(stderr, '', `grep reported errors, so the scan is not conclusive: ${stderr}`);

  // Control: the same check against a path that does not exist must be
  // detected as an error (exit 2), not mistaken for "no match".
  const { stdout: control } = await docker(
    'run', '--rm', '--network', 'none', '--entrypoint', 'sh', IMAGE, '-c',
    `grep -rlF -e '${PLANTED_SECRET}' /does-not-exist 2>/dev/null; echo "grep-exit=$?"`,
  );
  assert.equal(control.trim(), 'grep-exit=2');
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
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    const { stderr } = await docker('logs', name);
    ready = stderr.includes('listening on stdio');
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, 'server never logged "listening on stdio" within 5 s; not sending SIGTERM');

  const started = Date.now();
  await docker('stop', '--time', '10', name);
  const elapsed = Date.now() - started;
  const { stdout: state } = await docker('inspect', name, '--format', '{{.State.ExitCode}} {{.State.OOMKilled}}');
  // One call: the container's stdout and stderr come back separately.
  const { stdout: containerStdout, stderr: containerStderr } = await docker('logs', name);
  await docker('rm', name);
  named.delete(name);

  assert.equal(state.trim(), '0 false', 'exit code 0 means our SIGTERM handler ran (137 would mean SIGKILL)');
  assert.ok(elapsed < 8000, `stop took ${elapsed} ms; near 10 s would mean the signal was ignored`);
  assert.equal(containerStdout, '', 'nothing on stdout');
  assert.match(containerStderr, /SIGTERM received, shutting down/);
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
