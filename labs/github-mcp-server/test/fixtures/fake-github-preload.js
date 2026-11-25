// Loaded with `node --import` into the server's child process during tests.
// It replaces global fetch with a fake GitHub API so stdio tests are
// deterministic and never touch the network. Production code has no switch
// for this: the real server always calls the real https://api.github.com.

import { repoPayload, PLANTED_SECRET, ALNUM_SECRET_CODE, ALNUM_SECRET_NAME } from './github.js';

const EXPECTED_TOKEN = process.env.FAKE_GITHUB_ACCEPTED_TOKEN;

function respond(status, body, url, headers = {}) {
  const res = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.github.com') {
    throw new Error(`fake GitHub: unexpected destination ${url.origin}`);
  }
  const auth = init.headers?.Authorization;
  if (auth && EXPECTED_TOKEN && auth !== `Bearer ${EXPECTED_TOKEN}`) {
    return respond(401, { message: 'Bad credentials' }, url.href);
  }
  switch (url.pathname) {
    case '/repos/octo-org/hello-world':
      return respond(200, repoPayload(), url.href);
    case '/repos/octo-org/missing':
      return respond(404, { message: 'Not Found' }, url.href);
    case '/repos/octo-org/rate-limited':
      return respond(403, { message: 'API rate limit exceeded' }, url.href, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1798000000',
      });
    case '/repos/octo-org/slow':
      // Never answers; the server's timeout must abort it.
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    case '/repos/octo-org/renamed':
      // Behaves like Node's fetch: with redirect: 'error' a 301 becomes an
      // exception; with any other mode it would follow to another origin.
      if (init.redirect === 'error') {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      }
      return respond(200, repoPayload({ full_name: 'elsewhere/followed' }), 'https://elsewhere.example/followed');
    case '/repos/octo-org/secret-repo':
      // Private repository: visible only to an authenticated request, like GitHub.
      if (!auth) return respond(404, { message: 'Not Found' }, url.href);
      return respond(
        200,
        repoPayload({ full_name: 'octo-org/secret-repo', name: 'secret-repo', private: true, visibility: 'private', description: 'PRIVATE-DESCRIPTION' }),
        url.href,
      );
    case '/repos/octo-org/network-secret':
      // A network failure whose message and cause carry a secret.
      throw new TypeError(`fetch failed ${PLANTED_SECRET}`, {
        cause: Object.assign(new Error(`connect failed ${PLANTED_SECRET}`), { code: PLANTED_SECRET }),
      });
    case '/repos/octo-org/explode':
      // A response object that throws a secret-bearing exception when read,
      // reaching the server's "unexpected exception" path.
      return {
        ok: false,
        status: 403,
        url: url.href,
        headers: {
          get() {
            throw new Error(`boom ${PLANTED_SECRET}`);
          },
          has() {
            throw new Error(`boom ${PLANTED_SECRET}`);
          },
        },
      };
    case '/repos/octo-org/alnum-network':
      // Network failure whose error code is an alphanumeric secret.
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: ALNUM_SECRET_CODE }) });
    case '/repos/octo-org/alnum-explode':
      // Unexpected exception whose class name is an alphanumeric secret.
      return {
        ok: false,
        status: 403,
        url: url.href,
        headers: {
          has() {
            const err = new Error('x');
            err.name = ALNUM_SECRET_NAME;
            throw err;
          },
          get() {
            const err = new Error('x');
            err.name = ALNUM_SECRET_NAME;
            throw err;
          },
        },
      };
    default:
      return respond(500, { message: 'fake server error' }, url.href);
  }
};
