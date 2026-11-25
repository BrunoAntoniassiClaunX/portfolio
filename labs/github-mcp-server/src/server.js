// Builds the MCP server and its single tool. No side effects on import:
// starting the stdio connection lives in src/index.js, so tests can build a
// server with a fake GitHub client and talk to it in-process.

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { GitHubError, OWNER_PATTERN, REPO_PATTERN } from './github.js';

export const SERVER_INFO = { name: 'github-mcp-server', version: '0.3.0' };

const inputSchema = z.object({
  owner: z
    .string()
    .regex(OWNER_PATTERN, 'must be a GitHub user or organization name (letters, digits, hyphens; max 39)')
    .describe('Repository owner (user or organization), e.g. "nodejs"'),
  repo: z
    .string()
    .regex(REPO_PATTERN, 'must be a GitHub repository name (letters, digits, ".", "_", "-"; max 100)')
    .describe('Repository name, e.g. "node"'),
});

const outputSchema = z.object({
  fullName: z.string(),
  name: z.string(),
  owner: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable().describe('Primary language detected by GitHub'),
  stars: z.number().int(),
  forks: z.number().int(),
  openIssues: z.number().int().describe('Open issues plus open pull requests, as reported by GitHub'),
  defaultBranch: z.string(),
  pushedAt: z.string().nullable().describe('ISO 8601 time of the last push'),
  url: z.string(),
  archived: z.boolean(),
});

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Built-in error class names that may appear in logs. Any other name, and
// always the message and stack, is replaced by a constant.
const KNOWN_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
]);
export function errorKind(err) {
  return KNOWN_ERROR_NAMES.has(err?.name) ? err.name : 'unknown error';
}

/**
 * @param {object} deps
 * @param {{ getRepository(owner: string, repo: string): Promise<object> }} deps.github
 * @param {(msg: string) => void} [deps.log]  Diagnostic logger; must not write to stdout.
 */
export function createServer({ github, log = () => {} }) {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'get_repository',
    {
      title: 'Get GitHub repository',
      description:
        'Returns public metadata for a GitHub repository: description, primary language, stars, forks, open issues, default branch, last push time and URL.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ owner, repo }) => {
      try {
        const info = await github.getRepository(owner, repo);
        return {
          content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
          structuredContent: info,
        };
      } catch (err) {
        if (err instanceof GitHubError) {
          log(`get_repository ${owner}/${repo} failed: ${err.code}`);
          return errorResult(err.message);
        }
        // Unknown failure: its message or stack could carry secrets or
        // upstream text, so neither is emitted. Log only a safe class name.
        log(`get_repository ${owner}/${repo} failed unexpectedly (${errorKind(err)})`);
        return errorResult('Internal error while fetching repository metadata.');
      }
    },
  );

  return server;
}
