// LIVE check against the real GitHub API. Not part of `npm test`.
// Run with: npm run test:live
//
// Uses the official MCP client to launch the real server over stdio, with no
// fakes. Needs network access. Uses GITHUB_TOKEN only if it is already set in
// your environment; without it the unauthenticated limit (60 requests/hour) applies.
// Assertions are about shape and stable facts, not exact star counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const SERVER = fileURLToPath(new URL('../../src/index.js', import.meta.url));

test('live: get_repository for a real public repository (nodejs/node)', async () => {
  const env = getDefaultEnvironment();
  if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'pipe' });
  const client = new Client({ name: 'live-check', version: '0.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'get_repository', arguments: { owner: 'nodejs', repo: 'node' } });
    if (result.isError) {
      // Surface the server's own message (e.g. rate limit, network) as the failure reason.
      assert.fail(`tool returned an error: ${result.content[0]?.text}`);
    }
    const info = result.structuredContent;
    console.log('live result:', JSON.stringify(info));
    assert.equal(info.fullName, 'nodejs/node');
    assert.equal(info.url, 'https://github.com/nodejs/node');
    assert.equal(info.defaultBranch, 'main');
    assert.equal(info.language, 'JavaScript');
    assert.ok(info.stars > 1000);
    assert.ok(info.forks > 100);
    assert.ok(Number.isInteger(info.openIssues));
    assert.ok(!Number.isNaN(Date.parse(info.pushedAt)));

    const missing = await client.callTool({
      name: 'get_repository',
      arguments: { owner: 'nodejs', repo: 'this-repo-should-not-exist-7f3a9c' },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /not found/);
  } finally {
    await client.close();
  }
});
