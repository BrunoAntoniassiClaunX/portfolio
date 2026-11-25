# GitHub MCP Server (lab)

A small [Model Context Protocol](https://modelcontextprotocol.io) server in plain Node.js that lets an AI host look up public GitHub repository metadata. It is being built step by step as a portfolio exercise.

**Status: Milestone 2 of 4.** One tool, `get_repository`, served over stdio and backed by the public GitHub REST API. Docker and CI come in later milestones. This is a learning project, not a production service.

## Requirements

- Node.js 20 or later (developed on 24.15.0)
- npm
- Network access to `api.github.com` (only for real use and `npm run test:live`)

## Run it

```bash
npm ci              # install the exact versions from package-lock.json
npm test            # offline tests: unit, in-process, stdio protocol, official-client interop
npm run test:live   # one real call to the GitHub API (needs network)
npm start           # start the server; it waits for JSON-RPC on stdin
```

`npm start` looks like it hangs. That is expected: the server is waiting for an MCP client to write to its stdin. Press Ctrl+C to stop it.

### Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | not set | Optional. Raises the GitHub rate limit from 60 to 5,000 requests per hour. A fine-grained token with no extra permissions is enough for public repositories. It is only sent in the `Authorization` header and never logged. |
| `GITHUB_TIMEOUT_MS` | `10000` | Per-request timeout in milliseconds (100 to 60000). |

Do not put the token in a file inside this repository. Export it in your shell or set it in your MCP host's configuration.

### See it work end to end

```bash
npm run test:live
```

This is the reference demonstration. The official MCP client SDK starts the real server over stdio, as an MCP host would. It negotiates the protocol, calls `get_repository` for `nodejs/node` against the real GitHub API, and prints the structured result. Then it checks that a nonexistent repository returns a "not found" tool error. The client waits for each reply before it closes the connection, so there's no timing to get right. The code is in `test/live/github-live.test.js`.

To see the raw JSON-RPC messages without the network, read `test/smoke.test.js`. It drives the server line by line with fake GitHub responses.

### Inspect it interactively (optional)

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

## The tool

`get_repository(owner, repo)` returns:

| Field | Meaning |
| --- | --- |
| `fullName`, `name`, `owner` | Repository identity |
| `description`, `language` | May be `null` |
| `stars`, `forks` | Counts |
| `openIssues` | GitHub's `open_issues_count`, which **includes open pull requests** |
| `defaultBranch` | e.g. `main` |
| `pushedAt` | ISO 8601 time of the last push (may be `null`) |
| `url` | Web URL of the repository |
| `archived` | Whether the repository is archived |

The result has both `structuredContent` (validated against the declared `outputSchema`) and a JSON text copy for hosts that only read text.

Failures come back as tool results with `isError: true` and a readable message: invalid names, not found, not public, redirected (renamed or transferred), rate limited (with reset time), bad token, GitHub 5xx, malformed response, network error, and timeout.

**Use the repository's current name.** Redirects are never followed. If a repository was renamed or transferred, GitHub answers the old name with a redirect, and the tool returns a "redirected" error asking for the current owner and name.

**Public repositories only.** Metadata is returned only when GitHub reports `private: false` and `visibility: "public"`. Private and internal repositories are refused, even when a configured token could read them.

## Files

| File | Purpose |
| --- | --- |
| `src/github.js` | Calls the GitHub API: validates names, builds the fixed URL, sets the timeout and headers, maps HTTP failures to error codes, and checks the response shape. |
| `src/server.js` | Builds the MCP server and the `get_repository` tool. No side effects, so tests can import it. |
| `src/index.js` | Entry point: reads environment variables, starts stdio, handles shutdown signals. |
| `test/github.test.js` | Unit tests for `github.js` with a fake `fetch`. |
| `test/server.test.js` | Official MCP client talks to `createServer()` in memory, with a fake GitHub client. |
| `test/smoke.test.js` | Spawns the real server and checks raw JSON-RPC: both protocol versions, stdout purity, timeout, token hygiene, shutdown. |
| `test/interop.test.js` | Official MCP client launches the real server over stdio, in both protocol versions. |
| `test/fixtures/` | Sample GitHub data, and a fake GitHub API loaded into the server process only during tests (`node --import`). |
| `test/live/github-live.test.js` | One real call to GitHub. Run separately with `npm run test:live`. |

## Security choices

- **Fixed destination.** The tool takes only `owner` and `repo`, which must match GitHub's name character sets. The URL is always `https://api.github.com/repos/{owner}/{repo}`. Requests use `redirect: 'error'`, so no redirect is ever followed. As a second check, a response from any other origin is rejected.
- **Public-only.** Private and internal repositories are refused even when the request is authenticated.
- **Timeout on every request** via `AbortSignal.timeout`.
- **Token hygiene.** The token appears only in the `Authorization` header. Logs say whether a token is configured, never what it is. A test checks that a token never appears in stdout or stderr.
- **No raw error text.** Error messages are fixed strings. Messages and stack traces from unexpected exceptions are never sent to the client or logged; the only values shown come from fixed allowlists of built-in error class names (for example `TypeError`) and known network codes (for example `ENOTFOUND`). Anything else is replaced with "unknown error". Tests plant a fake secret inside failures and check that it never appears in tool output or stderr.
- **No secret files.** `.env` is in `.gitignore`; nothing reads `.env` automatically.

## Protocol support

The official SDK (`@modelcontextprotocol/server` 2.4.0) picks the protocol revision from the client's first message:

- **2025-11-25 and earlier:** `initialize` → `notifications/initialized` → requests.
- **2026-07-28:** no handshake; every request carries a `_meta` envelope, and `server/discover` lists supported versions.

Both are tested, with raw JSON-RPC and with the official client.

## Known limitations

- One tool only. No caching, so every call hits GitHub.
- Unauthenticated use is limited to 60 requests per hour per IP address.
- Without a token, a private repository looks like any missing one ("not found"). With a token that can read it, the tool says it is "not public", which confirms it exists.
- Renamed or transferred repositories are not resolved automatically; the caller has to retry with the current name.
- Redirect refusal depends on how Node's built-in fetch reports `redirect: 'error'` (`TypeError` with cause `unexpected redirect`). If a future Node version changes that, a redirect would show up as a generic "network error" rather than "redirected"; it would still not be followed.
- The response body size is not capped (GitHub's repository response is small).
- stdio only; no HTTP transport.
- Not yet tried inside a real MCP host such as Claude Desktop.
- The live test asserts stable facts about `nodejs/node` (language, default branch). If that repository changes, the live test needs updating.
