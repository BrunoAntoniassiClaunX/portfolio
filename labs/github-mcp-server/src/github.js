// GitHub REST API access for one operation: read public repository metadata.
//
// Safety properties:
// - The destination is fixed: every request goes to https://api.github.com/repos/{owner}/{repo}.
//   Callers pass only owner and repo names, which are checked against a strict
//   character set before any URL is built. Redirects are never followed
//   (`redirect: 'error'`), so a renamed or transferred repository must be
//   requested by its current name.
// - Public-only: metadata is returned only when GitHub reports the repository
//   as public, even if a token would allow reading a private one.
// - Every request has a timeout.
// - The token is only ever placed in the Authorization header. Error messages
//   are fixed strings built here; raw messages from fetch or GitHub are never
//   passed through.

import * as z from 'zod/v4';

export const API_ORIGIN = 'https://api.github.com';
export const DEFAULT_TIMEOUT_MS = 10_000;
const API_VERSION = '2022-11-28';
const USER_AGENT = 'github-mcp-server-lab';

// GitHub owner (user or org) names: letters, digits and hyphens, max 39 chars,
// no leading or trailing hyphen.
export const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Repository names: letters, digits, '.', '_' and '-', max 100 chars.
// '.' and '..' are excluded so the name can never act as a path segment.
export const REPO_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

// One error type with a `code`, so the MCP layer can turn every failure
// into a clear message without inspecting raw HTTP details.
export class GitHubError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.details = details;
  }
}

// Only the fields we use are checked. Extra fields are ignored.
const RepoResponseSchema = z.object({
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  description: z.string().nullable(),
  language: z.string().nullable(),
  stargazers_count: z.number().int().nonnegative(),
  forks_count: z.number().int().nonnegative(),
  open_issues_count: z.number().int().nonnegative(),
  default_branch: z.string(),
  pushed_at: z.string().nullable(),
  html_url: z.string().url(),
  private: z.boolean(),
  visibility: z.string(),
  archived: z.boolean(),
});

// Network error codes that may be shown to the caller. Only these exact
// values are ever echoed; any other code (however harmless it looks) is
// replaced by a constant, so nothing external is passed through.
const KNOWN_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);
function safeErrorCode(err) {
  const code = err?.cause?.code;
  return KNOWN_NETWORK_CODES.has(code) ? code : 'unknown error';
}

// Node's fetch reports `redirect: 'error'` as TypeError('fetch failed')
// with cause.message 'unexpected redirect'.
function isRedirectError(err) {
  return err?.name === 'TypeError' && err?.cause?.message === 'unexpected redirect';
}

export function buildRepoUrl(owner, repo) {
  if (!OWNER_PATTERN.test(owner)) throw new GitHubError('invalid_input', 'Invalid owner name.');
  if (!REPO_PATTERN.test(repo)) throw new GitHubError('invalid_input', 'Invalid repository name.');
  const url = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, API_ORIGIN);
  if (url.origin !== API_ORIGIN) throw new GitHubError('invalid_input', 'Refusing non-GitHub destination.');
  return url;
}

function rateLimitDetails(headers) {
  const reset = Number(headers.get('x-ratelimit-reset'));
  const retryAfter = Number(headers.get('retry-after'));
  return {
    ...(Number.isFinite(reset) && reset > 0 && { resetAt: new Date(reset * 1000).toISOString() }),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfterSeconds: retryAfter }),
  };
}

function errorForStatus(res, owner, repo) {
  const { status, headers } = res;
  const isRateLimited =
    status === 429 ||
    (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')));

  if (isRateLimited) {
    const details = rateLimitDetails(headers);
    const when = details.resetAt ? ` Limit resets at ${details.resetAt}.` : details.retryAfterSeconds ? ` Retry after ${details.retryAfterSeconds}s.` : '';
    return new GitHubError('rate_limited', `GitHub API rate limit exceeded.${when} Setting GITHUB_TOKEN raises the limit.`, details);
  }
  if (status === 404) {
    return new GitHubError('not_found', `Repository ${owner}/${repo} was not found, or it is private.`, { status });
  }
  if (status === 401) {
    return new GitHubError('unauthorized', 'GitHub rejected the configured GITHUB_TOKEN (HTTP 401).', { status });
  }
  if (status === 403) {
    return new GitHubError('forbidden', 'GitHub denied access to this repository (HTTP 403).', { status });
  }
  if (status >= 500) {
    return new GitHubError('upstream_error', `GitHub API error (HTTP ${status}). Try again later.`, { status });
  }
  return new GitHubError('unexpected_status', `Unexpected response from GitHub (HTTP ${status}).`, { status });
}

// Maps the GitHub response to the fields this server returns.
function toRepositoryInfo(data) {
  return {
    fullName: data.full_name,
    name: data.name,
    owner: data.owner.login,
    description: data.description,
    language: data.language,
    stars: data.stargazers_count,
    forks: data.forks_count,
    openIssues: data.open_issues_count,
    defaultBranch: data.default_branch,
    pushedAt: data.pushed_at,
    url: data.html_url,
    archived: data.archived,
  };
}

/**
 * Creates a GitHub client.
 * @param {object} [options]
 * @param {string} [options.token]      Optional token; sent as a Bearer header only.
 * @param {number} [options.timeoutMs]  Per-request timeout.
 * @param {Function} [options.fetch]    Fetch implementation (tests pass a fake).
 */
export function createGitHubClient({ token, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const authToken = typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined;

  async function getRepository(owner, repo) {
    const url = buildRepoUrl(owner, repo);
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      ...(authToken && { Authorization: `Bearer ${authToken}` }),
    };

    let res;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers,
        redirect: 'error', // never follow redirects, wherever they point
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new GitHubError('timeout', `GitHub API did not respond within ${timeoutMs} ms.`);
      }
      if (isRedirectError(err)) {
        throw new GitHubError(
          'redirected',
          `GitHub redirected the request for ${owner}/${repo}; the repository was probably renamed or transferred. Use its current owner and name.`,
        );
      }
      throw new GitHubError('network_error', `Could not reach the GitHub API (${safeErrorCode(err)}).`);
    }

    // Defense in depth: with redirects disabled the response URL is the
    // request URL, but never accept a response from another origin.
    if (res.url && new URL(res.url).origin !== API_ORIGIN) {
      throw new GitHubError('unexpected_status', 'GitHub API responded from an unexpected destination.');
    }

    if (!res.ok) throw errorForStatus(res, owner, repo);

    let body;
    try {
      body = await res.json();
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new GitHubError('timeout', `GitHub API did not respond within ${timeoutMs} ms.`);
      }
      throw new GitHubError('malformed_response', 'GitHub API returned a response that is not valid JSON.');
    }

    const parsed = RepoResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new GitHubError('malformed_response', 'GitHub API response is missing expected repository fields.');
    }
    // Public-only, checked on both fields. An authenticated request can
    // succeed for private or internal repositories; those are refused here.
    if (parsed.data.private !== false || parsed.data.visibility !== 'public') {
      throw new GitHubError('not_public', `Repository ${owner}/${repo} is not public. This tool only returns public repositories.`);
    }
    return toRepositoryInfo(parsed.data);
  }

  return { getRepository, authenticated: Boolean(authToken) };
}
