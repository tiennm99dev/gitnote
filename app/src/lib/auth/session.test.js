import { describe, expect, it } from 'vitest';
import { fetchDouble, jsonResponse, memoryStorage, memoryTokenStore } from '../../../test/auth-doubles.js';
import { ErrorCode } from '../git/errors.js';
import { authCallbacks } from '../git/http.js';
import { AuthErrorCode } from './errors.js';
import { createGithubAdapter } from './github.js';
import { createGitlabAdapter } from './gitlab.js';
import { pkceChallenge } from './oauth.js';
import { createAuthSession, REFRESH_MARGIN_MS } from './session.js';

const RELAY = 'https://relay.example.com';
const REDIRECT = 'https://app.example.com/auth/callback';
const HOUR = 3_600_000;
const START = 1_000_000_000_000;
const GITHUB_USER = { login: 'octo', name: 'Octo Cat', email: 'octo@example.com' };

/** @typedef {import('./session.js').Credential} Credential */

// The double's parts are inferred.
// eslint-disable-next-line jsdoc/require-returns
/**
 * A session against provider doubles. `handler` answers first; what it leaves
 * undefined gets the account behind any token and a 404.
 * @param {(url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>} [handler]
 */
function setup(handler = () => undefined) {
	const clock = { now: START };
	const store = memoryTokenStore();
	const pendingStorage = memoryStorage();
	const fetch = fetchDouble(async (url, init) => {
		const answer = await handler(url, init);
		if (answer) return answer;
		if (url.pathname.endsWith('/user')) return jsonResponse(url.hostname === 'api.github.com' ? GITHUB_USER : { username: 'tan', name: 'Tan', commit_email: 'tan@example.com' });
		return jsonResponse({ message: 'not found' }, 404);
	});
	/**
	 * @param {{ locks?: null }} [options]
	 * @returns {import('./session.js').AuthSession}
	 */
	const open = (options = {}) =>
		createAuthSession({
			store: /** @type {import('./token-store.js').TokenStore<Credential>} */ (store),
			adapters: {
				github: createGithubAdapter({ clientId: 'gh-client', appSlug: 'gitnote', relayOrigin: RELAY, fetch }),
				gitlab: createGitlabAdapter({ clientId: 'gl-client', fetch })
			},
			pendingStorage,
			fetch,
			now: () => clock.now,
			...options
		});
	return { clock, store, pendingStorage, fetch, session: open(), open };
}

/**
 * @param {ReturnType<typeof setup>['store']} store
 * @param {'github' | 'gitlab'} provider
 * @param {Partial<Credential>} [fields]
 * @returns {Promise<void>}
 */
function storeOauth(store, provider, fields = {}) {
	return store.set(provider, /** @type {never} */ ({ kind: 'oauth', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: START + 8 * HOUR, redirectUri: REDIRECT, user: { login: 'octo', name: null, email: null }, ...fields }));
}

/**
 * @param {ReturnType<typeof setup>['store']} store
 * @param {'github' | 'gitlab'} provider
 * @returns {Promise<void>}
 */
function storeToken(store, provider) {
	return store.set(provider, /** @type {never} */ ({ kind: 'token', accessToken: 'pasted', user: { login: 'octo', name: null, email: null } }));
}

/**
 * @param {URL} url
 * @param {RequestInit} init
 * @returns {boolean}
 */
const isRelayRefresh = (url, init) => url.origin === RELAY && url.pathname === '/api/oauth/github/refresh' && init.method === 'POST';

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<{ code?: string, message: string }>}
 */
async function failure(promise) {
	const error = await promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(/** @type {unknown} */ reason) => reason
	);
	return /** @type {{ code?: string, message: string }} */ (error);
}

describe('starting a sign-in', () => {
	it('sends GitHub the client ID, state and S256 challenge, and no scope', async () => {
		const { session, pendingStorage } = setup();

		const url = new URL(await session.beginSignIn('github', { redirectUri: REDIRECT }));

		expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
		expect(url.searchParams.get('client_id')).toBe('gh-client');
		expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.has('scope')).toBe(false);
		const state = String(url.searchParams.get('state'));
		const pending = JSON.parse(String(pendingStorage.getItem(`gitnote.oauth.pending.${state}`)));
		expect(url.searchParams.get('code_challenge')).toBe(await pkceChallenge(pending.verifier));
	});

	it('asks GitLab for the scopes the app needs', async () => {
		const { session } = setup();

		const url = new URL(await session.beginSignIn('gitlab', { redirectUri: REDIRECT }));

		expect(url.origin + url.pathname).toBe('https://gitlab.com/oauth/authorize');
		expect(url.searchParams.get('scope')).toBe('read_user read_api write_repository');
		expect(url.searchParams.get('response_type')).toBe('code');
	});

	it('refuses when this build has no client ID, before anything is saved', async () => {
		const pendingStorage = memoryStorage();
		const session = createAuthSession({
			store: memoryTokenStore(),
			adapters: { github: createGithubAdapter({ clientId: '', relayOrigin: RELAY }), gitlab: createGitlabAdapter({ clientId: '' }) },
			pendingStorage
		});

		expect(session.signInAvailable('github')).toBe(false);
		expect((await failure(session.beginSignIn('github', { redirectUri: REDIRECT }))).code).toBe(AuthErrorCode.SIGN_IN_FAILED);
		expect(pendingStorage.length).toBe(0);
	});
});

describe('finishing a sign-in', () => {
	/**
	 * @param {ReturnType<typeof setup>} context
	 * @param {'github' | 'gitlab'} provider
	 * @returns {Promise<string>} the state
	 */
	const begin = async ({ session }, provider) => String(new URL(await session.beginSignIn(provider, { redirectUri: REDIRECT })).searchParams.get('state'));

	it('trades a GitHub code through the relay and stores the pair', async () => {
		const context = setup((url) => (url.pathname === '/api/oauth/github/token' ? jsonResponse({ access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800, refresh_token_expires_in: 15897600 }) : undefined));
		const state = await begin(context, 'github');

		const account = await context.session.completeSignIn(`${REDIRECT}?code=the-code&state=${state}`);

		expect(account).toEqual({ provider: 'github', kind: 'oauth', user: GITHUB_USER, needsSignIn: false });
		const exchange = context.fetch.calls[0];
		expect(exchange.url.href).toBe(`${RELAY}/api/oauth/github/token`);
		const body = JSON.parse(String(exchange.init.body));
		expect(body).toMatchObject({ code: 'the-code', redirect_uri: REDIRECT });
		expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(body).not.toHaveProperty('client_secret');
		expect(await context.store.get('github')).toMatchObject({ kind: 'oauth', accessToken: 'ghu_new', refreshToken: 'ghr_new', expiresAt: START + 28_800_000, refreshExpiresAt: START + 15_897_600_000, user: GITHUB_USER });
	});

	it('trades a GitLab code directly with GitLab', async () => {
		const context = setup((url) => (url.href === 'https://gitlab.com/oauth/token' ? jsonResponse({ access_token: 'gl-new', refresh_token: 'gl-refresh', expires_in: 7200, token_type: 'bearer' }) : undefined));
		const state = await begin(context, 'gitlab');

		const account = await context.session.completeSignIn(`${REDIRECT}?code=the-code&state=${state}`);

		expect(account.user).toEqual({ login: 'tan', name: 'Tan', email: 'tan@example.com' });
		const form = new URLSearchParams(String(context.fetch.calls[0].init.body));
		expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'gl-client', redirect_uri: REDIRECT });
		expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(context.fetch.calls.some(({ url }) => url.origin === RELAY)).toBe(false);
		expect(await context.store.get('gitlab')).toMatchObject({ accessToken: 'gl-new', refreshToken: 'gl-refresh', redirectUri: REDIRECT });
	});

	it('refuses a state this device did not issue, with no network call and nothing stored', async () => {
		const context = setup();
		await begin(context, 'github');

		const error = await failure(context.session.completeSignIn(`${REDIRECT}?code=stolen&state=forged`));

		expect(error.code).toBe(AuthErrorCode.BAD_STATE);
		expect(context.fetch.calls).toEqual([]);
		expect(context.store.records.size).toBe(0);
	});

	it('refuses a replayed redirect', async () => {
		const context = setup((url) => (url.pathname === '/api/oauth/github/token' ? jsonResponse({ access_token: 'ghu_new' }) : undefined));
		const state = await begin(context, 'github');
		await context.session.completeSignIn(`${REDIRECT}?code=the-code&state=${state}`);

		const error = await failure(context.session.completeSignIn(`${REDIRECT}?code=the-code&state=${state}`));

		expect(error.code).toBe(AuthErrorCode.BAD_STATE);
	});

	it('refuses a redirect that took too long', async () => {
		const context = setup();
		const state = await begin(context, 'github');
		context.clock.now += HOUR;

		expect((await failure(context.session.completeSignIn(`${REDIRECT}?code=late&state=${state}`))).code).toBe(AuthErrorCode.BAD_STATE);
		expect(context.fetch.calls).toEqual([]);
	});

	it('explains a declined sign-in', async () => {
		const context = setup();
		const state = await begin(context, 'github');

		const error = await failure(context.session.completeSignIn(`${REDIRECT}?error=access_denied&error_description=ignored&state=${state}`));

		expect(error.code).toBe(AuthErrorCode.SIGN_IN_FAILED);
		expect(error.message).toContain('declined');
		expect(context.fetch.calls).toEqual([]);
	});

	it('reports a refused code, keeping what is stored', async () => {
		const context = setup((url) => (url.pathname === '/api/oauth/github/token' ? jsonResponse({ error: 'bad_verification_code', message: 'The code is incorrect or expired.' }, 400) : undefined));
		await storeOauth(context.store, 'github');
		const state = await begin(context, 'github');

		const error = await failure(context.session.completeSignIn(`${REDIRECT}?code=bad&state=${state}`));

		expect(error).toMatchObject({ code: AuthErrorCode.SIGN_IN_FAILED, message: 'The code is incorrect or expired.' });
		expect(await context.store.get('github')).toMatchObject({ accessToken: 'old-access' });
	});
});

describe('pasting a token', () => {
	it('checks it against the provider, then stores it trimmed', async () => {
		const { session, store, fetch } = setup();

		const account = await session.connectWithToken('github', '  ghp_pasted\n');

		expect(account).toEqual({ provider: 'github', kind: 'token', user: GITHUB_USER, needsSignIn: false });
		expect(fetch.calls[0].url.href).toBe('https://api.github.com/user');
		expect(new Headers(fetch.calls[0].init.headers).get('Authorization')).toBe('Bearer ghp_pasted');
		expect(await store.get('github')).toEqual({ kind: 'token', accessToken: 'ghp_pasted', user: GITHUB_USER });
	});

	it('checks a GitLab token against GitLab', async () => {
		const { session, fetch } = setup();

		await session.connectWithToken('gitlab', 'glpat-x');

		expect(fetch.calls[0].url.href).toBe('https://gitlab.com/api/v4/user');
	});

	it('stores nothing when the provider refuses it', async () => {
		const { session, store } = setup(() => jsonResponse({ message: 'Bad credentials' }, 401));

		const error = await failure(session.connectWithToken('github', 'ghp_bad'));

		expect(error.code).toBe(AuthErrorCode.TOKEN_REJECTED);
		expect(error.message).not.toContain('ghp_bad');
		expect(store.records.size).toBe(0);
	});

	it('says the network failed rather than blaming the token', async () => {
		const { session, store } = setup(() => {
			throw new TypeError('Failed to fetch');
		});

		expect((await failure(session.connectWithToken('github', 'ghp_any'))).code).toBe(AuthErrorCode.UNAVAILABLE);
		expect(store.records.size).toBe(0);
	});

	it.each(['', '   ', 'two words', 'line\nbreak'])('refuses %j with no network call', async (token) => {
		const { session, fetch } = setup();

		expect((await failure(session.connectWithToken('github', token))).code).toBe(AuthErrorCode.TOKEN_REJECTED);
		expect(fetch.calls).toEqual([]);
	});
});

describe('keeping tokens fresh', () => {
	/** @returns {(url: URL, init: RequestInit) => Response | undefined} */
	const relayRefreshes = () => {
		let round = 0;
		return (url, init) => {
			if (!isRelayRefresh(url, init)) return undefined;
			round += 1;
			return jsonResponse({ access_token: `new-access-${round}`, refresh_token: `new-refresh-${round}`, expires_in: 28800, refresh_token_expires_in: 15897600 });
		};
	};

	it('makes no refresh while the token has time left', async () => {
		const { session, store, fetch } = setup(relayRefreshes());
		await storeOauth(store, 'github');

		await session.gitCredentials('github')({ url: 'https://github.com/o/r.git', failed: false });

		expect(fetch.calls).toEqual([]);
	});

	it('refreshes shortly before expiry and replaces the pair', async () => {
		const { session, store, fetch } = setup(relayRefreshes());
		await storeOauth(store, 'github', { expiresAt: START + REFRESH_MARGIN_MS - 1 });

		const credential = await session.gitCredentials('github')({ url: 'https://github.com/o/r.git', failed: false });

		expect(credential).toEqual({ username: 'x-access-token', password: 'new-access-1' });
		expect(JSON.parse(String(fetch.calls[0].init.body))).toEqual({ refresh_token: 'old-refresh' });
		expect(await store.get('github')).toMatchObject({ accessToken: 'new-access-1', refreshToken: 'new-refresh-1', expiresAt: START + 28_800_000 });
	});

	it('sends GitLab the redirect URI the sign-in used', async () => {
		const { session, store, fetch } = setup((url) => (url.href === 'https://gitlab.com/oauth/token' ? jsonResponse({ access_token: 'gl-2', refresh_token: 'gl-r2', expires_in: 7200 }) : undefined));
		await storeOauth(store, 'gitlab', { expiresAt: START });

		await session.gitCredentials('gitlab')({ url: 'https://gitlab.com/o/r.git', failed: false });

		expect(Object.fromEntries(new URLSearchParams(String(fetch.calls[0].init.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh', redirect_uri: REDIRECT, client_id: 'gl-client' });
		expect(await store.get('gitlab')).toMatchObject({ accessToken: 'gl-2', refreshToken: 'gl-r2' });
	});

	it.each([[undefined], [null]])('spends a rotating refresh token once however many callers need it (locks: %j)', async (locks) => {
		const context = setup(relayRefreshes());
		await storeOauth(context.store, 'github', { expiresAt: START });
		const tabs = [context.open(locks === null ? { locks } : {}), context.open(locks === null ? { locks } : {}), context.open(locks === null ? { locks } : {})];
		const url = 'https://github.com/o/r.git';

		const credentials = await Promise.all(tabs.map((tab) => tab.gitCredentials('github')({ url, failed: false })));

		expect(context.fetch.calls.filter((call) => isRelayRefresh(call.url, call.init))).toHaveLength(1);
		expect(credentials.map((credential) => credential?.password)).toEqual(['new-access-1', 'new-access-1', 'new-access-1']);
	});

	it('keeps using a token still in date when the refresh cannot reach the relay', async () => {
		const { session, store } = setup(() => {
			throw new TypeError('Failed to fetch');
		});
		await storeOauth(store, 'github', { expiresAt: START + 60_000 });

		const credential = await session.gitCredentials('github')({ url: 'https://github.com/o/r.git', failed: false });

		expect(credential?.password).toBe('old-access');
		expect(await store.get('github')).toMatchObject({ refreshToken: 'old-refresh' });
	});

	it('reports a network failure for an expired token, and keeps the sign-in', async () => {
		const { session, store } = setup((url) => (url.origin === RELAY ? jsonResponse({ error: 'upstream_unreachable', message: 'x' }, 502) : undefined));
		await storeOauth(store, 'github', { expiresAt: START - 1 });

		const error = await failure(/** @type {Promise<unknown>} */ (session.gitCredentials('github')({ url: 'https://github.com/o/r.git', failed: false })));

		expect(error.code).toBe(ErrorCode.NETWORK);
		expect(await store.get('github')).not.toHaveProperty('needsSignIn');
	});

	it('asks for a new sign-in when the provider refuses the refresh, keeping the record', async () => {
		const { session, store, fetch } = setup((url) => (url.origin === RELAY ? jsonResponse({ error: 'bad_refresh_token', message: 'x' }, 400) : undefined));
		await storeOauth(store, 'github', { expiresAt: START - 1 });
		const source = session.gitCredentials('github');

		const error = await failure(/** @type {Promise<unknown>} */ (source({ url: 'https://github.com/o/r.git', failed: false })));

		expect(error.code).toBe(ErrorCode.AUTH_REQUIRED);
		expect(await store.get('github')).toMatchObject({ needsSignIn: true });
		expect((await session.listAccounts())[0].needsSignIn).toBe(true);

		// Dead for good: no second try spends anything.
		const calls = fetch.calls.length;
		await failure(/** @type {Promise<unknown>} */ (source({ url: 'https://github.com/o/r.git', failed: false })));
		expect(fetch.calls).toHaveLength(calls);
	});

	it('does not spend a refresh token past its own expiry', async () => {
		const { session, store, fetch } = setup();
		await storeOauth(store, 'github', { expiresAt: START - 1, refreshExpiresAt: START - 1 });

		expect((await failure(session.listRepos('github'))).code).toBe(AuthErrorCode.SIGN_IN_REQUIRED);
		expect(fetch.calls).toEqual([]);
	});

	it('a new sign-in clears the flag', async () => {
		const { session, store } = setup();
		await storeOauth(store, 'github', { needsSignIn: true });

		await session.connectWithToken('github', 'ghp_new');

		expect((await session.listAccounts())[0].needsSignIn).toBe(false);
	});
});

describe('REST calls', () => {
	const REPOS_PATH = '/user/repos';

	it('refresh once on a 401 and retry with the new token', async () => {
		const { session, store, fetch } = setup((url, init) => {
			if (isRelayRefresh(url, init)) return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800 });
			if (url.pathname.startsWith('/user/installations')) {
				return new Headers(init.headers).get('Authorization') === 'Bearer new-access' ? jsonResponse({ installations: [] }) : jsonResponse({ message: 'Bad credentials' }, 401);
			}
			return undefined;
		});
		await storeOauth(store, 'github');

		expect((await session.listRepos('github')).repos).toEqual([]);

		expect(fetch.calls.filter((call) => isRelayRefresh(call.url, call.init))).toHaveLength(1);
		expect(await store.get('github')).toMatchObject({ accessToken: 'new-access' });
	});

	it('use the pair another tab already stored rather than refreshing again', async () => {
		const context = setup((url, init) => {
			if (url.pathname.startsWith('/user/installations')) {
				if (new Headers(init.headers).get('Authorization') === 'Bearer from-other-tab') return jsonResponse({ installations: [] });
				return context.store.set('github', /** @type {never} */ ({ kind: 'oauth', accessToken: 'from-other-tab', refreshToken: 'r2', user: { login: 'octo', name: null, email: null } })).then(() => jsonResponse({}, 401));
			}
			return undefined;
		});
		await storeOauth(context.store, 'github');

		await context.session.listRepos('github');

		expect(context.fetch.calls.some((call) => isRelayRefresh(call.url, call.init))).toBe(false);
	});

	it('end the sign-in when even the new token is refused', async () => {
		const { session, store } = setup((url, init) => {
			if (isRelayRefresh(url, init)) return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800 });
			if (url.pathname.startsWith('/user/installations')) return jsonResponse({}, 401);
			return undefined;
		});
		await storeOauth(store, 'github');

		expect((await failure(session.listRepos('github'))).code).toBe(AuthErrorCode.SIGN_IN_REQUIRED);
		expect(await store.get('github')).toMatchObject({ needsSignIn: true });
	});

	it('end a pasted token on a 401, which has nothing to refresh with', async () => {
		const { session, store, fetch } = setup((url) => (url.pathname === REPOS_PATH ? jsonResponse({}, 401) : undefined));
		await storeToken(store, 'github');

		expect((await failure(session.listRepos('github'))).code).toBe(AuthErrorCode.SIGN_IN_REQUIRED);
		expect(await store.get('github')).toMatchObject({ needsSignIn: true });
		expect(fetch.calls.some(({ url }) => url.origin === RELAY)).toBe(false);
	});

	it('say which failure it was, without ending the sign-in', async () => {
		const { session, store } = setup((url) => (url.pathname === REPOS_PATH ? jsonResponse({ message: 'rate limit' }, 403) : undefined));
		await storeToken(store, 'github');

		expect((await failure(session.listRepos('github'))).code).toBe(AuthErrorCode.FORBIDDEN);
		expect(await store.get('github')).not.toHaveProperty('needsSignIn');
	});

	it('need a connected account', async () => {
		const { session } = setup();

		expect((await failure(session.listRepos('gitlab'))).code).toBe(AuthErrorCode.NOT_CONNECTED);
	});
});

describe('git credentials', () => {
	const GITHUB_URL = 'https://github.com/o/r.git';

	it('use each provider\'s git username', async () => {
		const { session, store } = setup();
		await storeToken(store, 'github');
		await storeToken(store, 'gitlab');

		expect(await session.gitCredentials('github')({ url: GITHUB_URL, failed: false })).toEqual({ username: 'x-access-token', password: 'pasted' });
		expect(await session.gitCredentials('gitlab')({ url: 'https://gitlab.com/g/s/r.git', failed: false })).toEqual({ username: 'oauth2', password: 'pasted' });
	});

	it.each(['https://evil.example.com/o/r.git', 'https://gitlab.com/o/r.git', 'http://github.com/o/r.git', 'https://github.com.evil.example.com/o/r.git', 'not a url'])('never send a GitHub token for %s', async (url) => {
		const { session, store } = setup();
		await storeToken(store, 'github');

		expect((await failure(/** @type {Promise<unknown>} */ (session.gitCredentials('github')({ url, failed: false })))).code).toBe(ErrorCode.HOST_NOT_ALLOWED);
	});

	it('refresh once after a host refuses the token, then give up', async () => {
		const { session, store, fetch } = setup((url, init) => (isRelayRefresh(url, init) ? jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800 }) : undefined));
		await storeOauth(store, 'github');
		const { onAuth, onAuthFailure } = authCallbacks(session.gitCredentials('github'));

		expect(await onAuth?.(GITHUB_URL)).toEqual({ username: 'x-access-token', password: 'old-access' });
		expect(await onAuthFailure?.(GITHUB_URL)).toEqual({ username: 'x-access-token', password: 'new-access' });
		expect(await onAuthFailure?.(GITHUB_URL)).toBeUndefined();
		expect(fetch.calls.filter((call) => isRelayRefresh(call.url, call.init))).toHaveLength(1);
	});

	it('leave a pasted token alone when only this repo refused it', async () => {
		const { session, store } = setup();
		await storeToken(store, 'github');
		const source = session.gitCredentials('github');
		await source({ url: GITHUB_URL, failed: false });

		expect(await source({ url: GITHUB_URL, failed: true })).toBeNull();
		expect(await store.get('github')).not.toHaveProperty('needsSignIn');
	});

	it('end a pasted token the API refuses too', async () => {
		const { session, store } = setup((url) => (url.pathname.endsWith('/user') ? jsonResponse({}, 401) : undefined));
		await storeToken(store, 'github');
		const source = session.gitCredentials('github');
		await source({ url: GITHUB_URL, failed: false });

		expect((await failure(/** @type {Promise<unknown>} */ (source({ url: GITHUB_URL, failed: true })))).code).toBe(ErrorCode.AUTH_REQUIRED);
		expect(await store.get('github')).toMatchObject({ needsSignIn: true });
	});

	it('report a missing account as needing a sign-in', async () => {
		const { session } = setup();

		expect((await failure(/** @type {Promise<unknown>} */ (session.gitCredentials('github')({ url: GITHUB_URL, failed: false })))).code).toBe(ErrorCode.AUTH_REQUIRED);
	});
});

describe('signing out', () => {
	it('removes the record', async () => {
		const { session, store } = setup();
		await storeOauth(store, 'github');

		await session.signOut('github');

		expect(store.records.size).toBe(0);
		expect(await session.listAccounts()).toEqual([]);
	});

	it('waits for a refresh in progress, so its answer cannot bring the token back', async () => {
		/** @type {() => void} */
		let release = () => {};
		const held = new Promise((resolve) => {
			release = () => resolve(undefined);
		});
		const { session, store } = setup(async (url, init) => {
			if (!isRelayRefresh(url, init)) return undefined;
			await held;
			return jsonResponse({ access_token: 'late', refresh_token: 'late-r', expires_in: 28800 });
		});
		await storeOauth(store, 'github', { expiresAt: START });

		const refreshing = session.gitCredentials('github')({ url: 'https://github.com/o/r.git', failed: false });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const leaving = session.signOut('github');
		release();
		await Promise.all([refreshing, leaving]);

		expect(store.records.size).toBe(0);
	});
});
