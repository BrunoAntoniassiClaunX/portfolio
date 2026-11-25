#!/usr/bin/env node
// Entry point: reads configuration from the environment and serves MCP over stdio.
//
// stdout is the JSON-RPC channel: every line written there must be a protocol
// message. All diagnostics go to stderr (console.error), never console.log.

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createGitHubClient, DEFAULT_TIMEOUT_MS } from './github.js';
import { createServer, errorKind, SERVER_INFO } from './server.js';

const log = (msg) => console.error(`[${SERVER_INFO.name}] ${msg}`);

function readTimeout() {
  const raw = process.env.GITHUB_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 100 || ms > 60_000) {
    log(`ignoring invalid GITHUB_TIMEOUT_MS; using ${DEFAULT_TIMEOUT_MS}`);
    return DEFAULT_TIMEOUT_MS;
  }
  return ms;
}

const github = createGitHubClient({ token: process.env.GITHUB_TOKEN, timeoutMs: readTimeout() });

// serveStdio reads the client's first message, picks the protocol era, then
// calls this factory once to build the server for the connection.
const handle = serveStdio(() => createServer({ github, log }));
// Never log the token itself, only whether one is configured.
log(`listening on stdio (GitHub auth: ${github.authenticated ? 'token' : 'none'})`);

// Close cleanly on Ctrl+C or `docker stop`. stdin EOF also closes the transport.
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`${signal} received, shutting down`);
  Promise.resolve(handle.close())
    .then(() => process.exit(0))
    .catch((err) => {
      log(`error during shutdown (${errorKind(err)})`);
      process.exit(1);
    });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
