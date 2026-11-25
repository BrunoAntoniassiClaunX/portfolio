// LIVE check of the container against the real GitHub API.
// Run with: npm run test:container:live   (needs Docker, the image, and network)
// GITHUB_TOKEN is passed into the container only if it is set in your shell,
// by name (-e GITHUB_TOKEN), so its value never appears in the command line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const IMAGE = process.env.MCP_IMAGE ?? 'github-mcp-server:local';

test('live (container): get_repository for nodejs/node through docker run -i', async () => {
  const env = getDefaultEnvironment();
  const args = ['run', '-i', '--rm'];
  if (process.env.GITHUB_TOKEN) {
    env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    args.push('-e', 'GITHUB_TOKEN');
  }
  args.push(IMAGE);

  const transport = new StdioClientTransport({ command: 'docker', args, env, stderr: 'pipe' });
  const client = new Client({ name: 'container-live-check', version: '0.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'get_repository', arguments: { owner: 'nodejs', repo: 'node' } });
    if (result.isError) assert.fail(`tool returned an error: ${result.content[0]?.text}`);
    const info = result.structuredContent;
    console.log('live container result:', JSON.stringify(info));
    assert.equal(info.fullName, 'nodejs/node');
    assert.equal(info.defaultBranch, 'main');
    assert.ok(info.stars > 1000);
  } finally {
    await client.close();
  }
});
