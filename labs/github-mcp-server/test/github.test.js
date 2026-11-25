// Unit tests for src/github.js. A fake fetch stands in for the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubClient, buildRepoUrl, GitHubError } from '../src/github.js';
import { repoPayload, EXPECTED_INFO, jsonResponse, fakeFetch, hangingFetch, PLANTED_SECRET, ALNUM_SECRET_CODE } from './fixtures/github.js';

async function expectGitHubError(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof GitHubError, `expected GitHubError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

test('success: maps the GitHub payload to the public fields', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, repoPayload()));
  const gh = createGitHubClient({ fetch });
  assert.deepEqual(await gh.getRepository('octo-org', 'hello-world'), EXPECTED_INFO);
});

test('success: nullable fields (no description, language or pushes) are kept as null', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, repoPayload({ description: null, language: null, pushed_at: null })));
  const info = await createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world');
  assert.equal(info.description, null);
  assert.equal(info.language, null);
  assert.equal(info.pushedAt, null);
});

test('request: fixed GitHub URL, GET, required headers, no token by default', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, repoPayload()));
  await createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world');
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.github.com/repos/octo-org/hello-world');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Accept, 'application/vnd.github+json');
  assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(init.headers['User-Agent']);
  assert.equal(init.headers.Authorization, undefined);
  assert.ok(init.signal instanceof AbortSignal, 'request must carry a timeout signal');
  assert.equal(init.redirect, 'error', 'redirects must be disabled at request time');
});

test('token: sent only as a Bearer header; blank token is ignored', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, repoPayload()));
  const gh = createGitHubClient({ fetch, token: '  test-token-123  ' });
  assert.equal(gh.authenticated, true);
  await gh.getRepository('octo-org', 'hello-world');
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer test-token-123');
  assert.ok(!fetch.calls[0].url.includes('test-token-123'));

  assert.equal(createGitHubClient({ fetch, token: '   ' }).authenticated, false);
});

test('input: names outside the GitHub character set never reach fetch', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, repoPayload()));
  const gh = createGitHubClient({ fetch });
  const bad = [
    ['', 'repo'],
    ['-owner', 'repo'],
    ['owner-', 'repo'],
    ['a'.repeat(40), 'repo'],
    ['own/er', 'repo'],
    ['owner', ''],
    ['owner', '..'],
    ['owner', '.'],
    ['owner', 'a/b'],
    ['owner', '../../users/x'],
    ['owner', 'repo?x=1'],
    ['owner', 'repo#x'],
    ['owner', 'r'.repeat(101)],
    ['https://evil.example', 'repo'],
    ['owner', '%2e%2e'],
  ];
  for (const [owner, repo] of bad) {
    await expectGitHubError(gh.getRepository(owner, repo), 'invalid_input');
  }
  assert.equal(fetch.calls.length, 0);
});

test('input: valid edge-case names build the expected URL', () => {
  assert.equal(buildRepoUrl('a', 'b').href, 'https://api.github.com/repos/a/b');
  assert.equal(buildRepoUrl('my-org', 'repo.js_v2-x').href, 'https://api.github.com/repos/my-org/repo.js_v2-x');
  assert.equal(buildRepoUrl('octo', '.github').href, 'https://api.github.com/repos/octo/.github');
});

test('404: not found (or private)', async () => {
  const fetch = fakeFetch(() => jsonResponse(404, { message: 'Not Found' }));
  await expectGitHubError(createGitHubClient({ fetch }).getRepository('octo-org', 'nope'), 'not_found');
});

test('rate limit: 403 with x-ratelimit-remaining: 0 reports the reset time', async () => {
  const fetch = fakeFetch(() =>
    jsonResponse(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1798000000' }),
  );
  const err = await createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world').catch((e) => e);
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.details.resetAt, new Date(1798000000 * 1000).toISOString());
  assert.match(err.message, /rate limit/);
});

test('rate limit: 429 and secondary limits (403 + retry-after)', async () => {
  for (const [status, headers] of [
    [429, { 'retry-after': '30' }],
    [403, { 'retry-after': '60' }],
  ]) {
    const fetch = fakeFetch(() => jsonResponse(status, { message: 'slow down' }, headers));
    const err = await createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world').catch((e) => e);
    assert.equal(err.code, 'rate_limited');
    assert.ok(err.details.retryAfterSeconds > 0);
  }
});

test('403 without rate-limit headers is reported as forbidden', async () => {
  const fetch = fakeFetch(() => jsonResponse(403, { message: 'Forbidden' }, { 'x-ratelimit-remaining': '50' }));
  await expectGitHubError(createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world'), 'forbidden');
});

test('401: bad token is reported without revealing it', async () => {
  const fetch = fakeFetch(() => jsonResponse(401, { message: 'Bad credentials' }));
  const err = await createGitHubClient({ fetch, token: 'secret-abc' }).getRepository('octo-org', 'x').catch((e) => e);
  assert.equal(err.code, 'unauthorized');
  assert.ok(!err.message.includes('secret-abc'));
  assert.ok(!JSON.stringify(err.details).includes('secret-abc'));
});

test('5xx: upstream failure', async () => {
  for (const status of [500, 502, 503]) {
    const fetch = fakeFetch(() => jsonResponse(status, 'oops'));
    await expectGitHubError(createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world'), 'upstream_error');
  }
});

test('other statuses: unexpected_status', async () => {
  const fetch = fakeFetch(() => jsonResponse(418, {}));
  await expectGitHubError(createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world'), 'unexpected_status');
});

test('malformed: body that is not JSON', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, '<html>not json</html>'));
  await expectGitHubError(createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world'), 'malformed_response');
});

test('malformed: JSON missing or mistyping required fields', async () => {
  const bodies = [{}, [], null, repoPayload({ stargazers_count: 'many' }), repoPayload({ html_url: 'not a url' }), repoPayload({ owner: null })];
  for (const body of bodies) {
    const fetch = fakeFetch(() => jsonResponse(200, body));
    await expectGitHubError(createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world'), 'malformed_response');
  }
});

test('network error: fetch throws (DNS failure, connection refused)', async () => {
  const fetch = fakeFetch(() => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  });
  const err = await createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world').catch((e) => e);
  assert.equal(err.code, 'network_error');
  assert.match(err.message, /ENOTFOUND/);
});

test('network error: secret-bearing messages and codes are never echoed', async () => {
  const SECRET = PLANTED_SECRET;
  const fetch = fakeFetch(() => {
    throw new TypeError(`fetch failed ${SECRET}`, {
      cause: Object.assign(new Error(`connect ${SECRET}`), { code: `E_${SECRET}` }),
    });
  });
  const err = await createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world').catch((e) => e);
  assert.equal(err.code, 'network_error');
  assert.equal(err.message, 'Could not reach the GitHub API (unknown error).');
  assert.ok(!JSON.stringify({ m: err.message, d: err.details }).includes(SECRET));
});

test('network error: an alphanumeric code that looks like ENOTFOUND but is not allowlisted is not echoed', async () => {
  assert.match(ALNUM_SECRET_CODE, /^[A-Z][A-Z0-9_]{1,31}$/, 'fixture must pass the old regex');
  const fetch = fakeFetch(() => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: ALNUM_SECRET_CODE }) });
  });
  const err = await createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world').catch((e) => e);
  assert.equal(err.message, 'Could not reach the GitHub API (unknown error).');
  assert.ok(!err.message.includes(ALNUM_SECRET_CODE));
});

test('timeout: a hanging request is aborted after timeoutMs', async () => {
  const started = Date.now();
  const gh = createGitHubClient({ fetch: hangingFetch(), timeoutMs: 150 });
  await expectGitHubError(gh.getRepository('octo-org', 'hello-world'), 'timeout');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 140 && elapsed < 2000, `aborted after ${elapsed} ms`);
});

test('redirect: the error Node raises for redirect: "error" becomes a clear "redirected" error', async () => {
  // Same shape Node's fetch produces for a 301 when redirect is 'error'
  // (checked against a local HTTP server during development).
  const fetch = fakeFetch((url, init) => {
    assert.equal(init.redirect, 'error');
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  });
  const err = await createGitHubClient({ fetch }).getRepository('octo-org', 'old-name').catch((e) => e);
  assert.equal(err.code, 'redirected');
  assert.match(err.message, /octo-org\/old-name/);
  assert.match(err.message, /current owner and name/);
});

test('redirect (defense in depth): a response from another origin is rejected', async () => {
  const fetch = fakeFetch(() => jsonResponse(200, repoPayload(), {}, 'https://evil.example/repos/x/y'));
  await expectGitHubError(createGitHubClient({ fetch }).getRepository('octo-org', 'hello-world'), 'unexpected_status');
});

test('public-only: authenticated success for private or internal repos is refused', async () => {
  const cases = [
    { private: true, visibility: 'private' },
    { private: false, visibility: 'internal' },
    { private: true, visibility: 'public' }, // inconsistent: either flag is enough to refuse
    { private: false, visibility: 'something-new' },
  ];
  for (const flags of cases) {
    const fetch = fakeFetch(() => jsonResponse(200, repoPayload({ ...flags, description: 'PRIVATE-DESCRIPTION' })));
    const gh = createGitHubClient({ fetch, token: 'test-token-123' });
    const err = await gh.getRepository('octo-org', 'hello-world').catch((e) => e);
    assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer test-token-123', 'request was authenticated');
    assert.ok(err instanceof GitHubError, `expected refusal for ${JSON.stringify(flags)}`);
    assert.equal(err.code, 'not_public');
    assert.ok(!err.message.includes('PRIVATE-DESCRIPTION'));
  }
});

test('public-only: a response without the visibility field is treated as malformed', async () => {
  const payload = repoPayload();
  delete payload.visibility;
  const fetch = fakeFetch(() => jsonResponse(200, payload));
  await expectGitHubError(createGitHubClient({ fetch, token: 't' }).getRepository('octo-org', 'hello-world'), 'malformed_response');
});
