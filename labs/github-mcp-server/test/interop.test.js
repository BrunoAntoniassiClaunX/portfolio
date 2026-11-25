// Interoperability: the official MCP client SDK launches the real server over
// stdio (as a host such as Claude Desktop would) and calls the tool.
// GitHub is faked inside the server process; no network is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { EXPECTED_INFO } from './fixtures/github.js';

const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL('./fixtures/fake-github-preload.js', import.meta.url));

async function connect(clientOptions = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', FAKE_GITHUB, SERVER],
    env: getDefaultEnvironment(), // no GITHUB_TOKEN passed through
    stderr: 'pipe',
  });
  const client = new Client({ name: 'interop-test', version: '0.0.0' }, clientOptions);
  await client.connect(transport);
  return client;
}

for (const [label, options, expectedVersion] of [
  ['default (2025 handshake)', {}, '2025-11-25'],
  ['pinned 2026-07-28', { versionNegotiation: { mode: { pin: '2026-07-28' } } }, '2026-07-28'],
]) {
  test(`official client, ${label}: negotiate, list, call, error, close`, async () => {
    const client = await connect(options);
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), expectedVersion);
      assert.equal(client.getServerVersion()?.name, 'github-mcp-server');

      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ['get_repository']);

      // The client validates structuredContent against the tool's outputSchema;
      // a mismatch would throw here.
      const ok = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'hello-world' } });
      assert.deepEqual(ok.structuredContent, EXPECTED_INFO);

      const missing = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org', repo: 'missing' } });
      assert.equal(missing.isError, true);

      const invalid = await client.callTool({ name: 'get_repository', arguments: { owner: 'octo-org' } });
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
    }
  });
}
