// Shared test data and a fake fetch. No network access.

// Planted inside simulated failures by the secret-safety tests; it must never
// appear in tool output, stdout or stderr.
export const PLANTED_SECRET = 'planted-secret-value-7c1e';
// Alphanumeric secrets shaped to pass the earlier regex filters:
// an error code matching /^[A-Z][A-Z0-9_]{1,31}$/ and an error name
// matching /^[A-Za-z][A-Za-z0-9]{0,39}$/. Only an allowlist stops them.
export const ALNUM_SECRET_CODE = 'GHSECRET7C1E9A2B';
export const ALNUM_SECRET_NAME = 'Secret7c1e9a2bToken';

// A trimmed copy of the shape GitHub returns for GET /repos/{owner}/{repo}.
export function repoPayload(overrides = {}) {
  return {
    id: 1,
    full_name: 'octo-org/hello-world',
    name: 'hello-world',
    owner: { login: 'octo-org', id: 2 },
    private: false,
    visibility: 'public',
    archived: false,
    description: 'A test repository',
    language: 'JavaScript',
    stargazers_count: 42,
    watchers_count: 42,
    forks_count: 7,
    open_issues_count: 3,
    default_branch: 'main',
    pushed_at: '2026-11-20T12:00:00Z',
    html_url: 'https://github.com/octo-org/hello-world',
    ...overrides,
  };
}

export const EXPECTED_INFO = {
  fullName: 'octo-org/hello-world',
  name: 'hello-world',
  owner: 'octo-org',
  description: 'A test repository',
  language: 'JavaScript',
  stars: 42,
  forks: 7,
  openIssues: 3,
  defaultBranch: 'main',
  pushedAt: '2026-11-20T12:00:00Z',
  url: 'https://github.com/octo-org/hello-world',
  archived: false,
};

// Builds a real Response whose .url is set, like one returned by fetch.
export function jsonResponse(status, body, headers = {}, url = 'https://api.github.com/repos/octo-org/hello-world') {
  const res = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

// A fetch that records calls and answers with the given handler.
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

// A fetch that never answers until its abort signal fires (to test timeouts).
// Like a real stalled connection, it holds an open handle until aborted.
// Without it, nothing keeps the event loop alive: AbortSignal.timeout() uses
// an unref'd timer, and Node 22's test runner then ends the test early.
export function hangingFetch() {
  return (url, init) =>
    new Promise((_, reject) => {
      const openSocket = setInterval(() => {}, 60_000);
      init.signal.addEventListener('abort', () => {
        clearInterval(openSocket);
        reject(init.signal.reason);
      });
    });
}
