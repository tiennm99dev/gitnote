import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../test/auth-doubles.js';
import { AuthErrorCode } from './errors.js';
import { createGithubAdapter } from './github.js';
import { createGitlabAdapter } from './gitlab.js';
import { isTokenText, parseTokenResponse, PENDING_TTL_MS, pkceChallenge, randomToken, savePending, takePending } from './oauth.js';

/** @type {import('./oauth.js').PendingSignIn} */
const PENDING = { provider: 'github', verifier: 'v', redirectUri: 'https://app.example.com/auth/callback', createdAt: 1000 };

describe('PKCE', () => {
	it('matches the worked example in RFC 7636', async () => {
		expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
	});

	it('makes verifiers the relay and the providers accept, different every time', () => {
		const first = randomToken();
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(randomToken()).not.toBe(first);
	});
});

describe('pending sign-ins', () => {
	it('work once', () => {
		const storage = memoryStorage();
		savePending(storage, 'state', PENDING, 1000);

		expect(takePending(storage, 'state', 2000)).toEqual(PENDING);
		expect(takePending(storage, 'state', 2000)).toBeNull();
	});

	it('are found only by their own state', () => {
		const storage = memoryStorage();
		savePending(storage, 'one', PENDING, 1000);
		savePending(storage, 'two', { ...PENDING, provider: 'gitlab' }, 1000);

		expect(takePending(storage, 'other', 2000)).toBeNull();
		expect(takePending(storage, 'two', 2000)?.provider).toBe('gitlab');
		expect(takePending(storage, 'one', 2000)?.provider).toBe('github');
	});

	it('expire, and a later sign-in clears the abandoned ones', () => {
		const storage = memoryStorage();
		savePending(storage, 'old', PENDING, 1000);
		expect(takePending(storage, 'old', 1000 + PENDING_TTL_MS + 1)).toBeNull();

		savePending(storage, 'abandoned', PENDING, 1000);
		savePending(storage, 'new', { ...PENDING, createdAt: 1000 + PENDING_TTL_MS + 1 }, 1000 + PENDING_TTL_MS + 1);
		expect(storage.length).toBe(1);
	});

	it('ignore a damaged entry', () => {
		const storage = memoryStorage();
		storage.setItem('gitnote.oauth.pending.state', '{not json');
		expect(takePending(storage, 'state', 1000)).toBeNull();
	});
});

describe('parseTokenResponse', () => {
	it('turns lifetimes into expiry times', () => {
		expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 28800, refresh_token_expires_in: 15897600, scope: '' }, 1000)).toEqual({
			accessToken: 'a',
			refreshToken: 'r',
			expiresAt: 1000 + 28800 * 1000,
			refreshExpiresAt: 1000 + 15897600 * 1000
		});
	});

	it('accepts a token that does not expire', () => {
		expect(parseTokenResponse({ access_token: 'a' }, 1000)).toEqual({ accessToken: 'a' });
	});

	it.each([[null], ['text'], [{}], [{ access_token: 'has space' }], [{ access_token: 5 }]])('refuses %j', (data) => {
		expect(() => parseTokenResponse(data, 1000)).toThrow(expect.objectContaining({ code: AuthErrorCode.UNAVAILABLE }));
	});
});

describe('a token endpoint that answers with an outage', () => {
	const REDIRECT = 'https://app.example.com/auth/callback';
	const SETUP_MESSAGE = 'GitHub sign-in is not configured on this relay.';

	/**
	 * @param {number} status
	 * @param {unknown} body
	 * @returns {typeof fetch}
	 */
	const answering = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
	/**
	 * @param {typeof fetch} fetch
	 * @returns {import('./session.js').ProviderAdapter}
	 */
	const github = (fetch) => createGithubAdapter({ clientId: 'id', relayOrigin: 'https://relay.example.com', fetch });
	const exchange = { code: 'c', verifier: 'v', redirectUri: REDIRECT, now: 1000 };

	it.each([502, 503])("shows the relay's own reason for a %i on sign-in, so a setup mistake does not read as an outage", async (status) => {
		const failed = github(answering(status, { error: 'oauth_not_configured', message: SETUP_MESSAGE })).exchangeCode(exchange);

		await expect(failed).rejects.toMatchObject({ code: AuthErrorCode.UNAVAILABLE, message: expect.stringContaining(SETUP_MESSAGE) });
	});

	it.each([
		['no reason', 503, {}],
		['a page instead of JSON', 502, '<html>Bad gateway</html>'],
		['an empty reason', 503, { message: '' }],
		['a reason that is not text', 503, { message: { nested: true } }]
	])('falls back to the plain outage message with %s', async (_label, status, body) => {
		const failed = github(answering(status, body)).exchangeCode(exchange);

		await expect(failed).rejects.toMatchObject({ code: AuthErrorCode.UNAVAILABLE, message: expect.stringContaining('not available right now') });
	});

	it('does not present a rate limit as a reason', async () => {
		const failed = github(answering(429, { message: 'slow down' })).exchangeCode(exchange);

		await expect(failed).rejects.toMatchObject({ code: AuthErrorCode.UNAVAILABLE, message: expect.stringContaining('not available right now') });
	});

	it('keeps a refresh unavailable and general, so the sign-in stays', async () => {
		const failed = github(answering(502, { error: 'incorrect_client_credentials', message: 'The client secret is wrong.' })).refresh({ refreshToken: 'r', now: 1000 });

		await expect(failed).rejects.toMatchObject({ code: AuthErrorCode.UNAVAILABLE, message: expect.stringContaining('not available right now') });
	});

	it('does not repeat what a provider says in its own outage', async () => {
		const failed = createGitlabAdapter({ clientId: 'id', fetch: answering(500, { message: 'internal detail' }) }).exchangeCode(exchange);

		await expect(failed).rejects.toMatchObject({ code: AuthErrorCode.UNAVAILABLE, message: expect.stringContaining('not available right now') });
	});
});

describe('isTokenText', () => {
	it.each(['ghu_abc', 'glpat-x.y_z'])('accepts %j', (token) => {
		expect(isTokenText(token)).toBe(true);
	});

	it.each(['', 'a b', 'a\r\nX-Injected: 1', 'é', 'x'.repeat(4097), 5, null])('refuses %j', (token) => {
		expect(isTokenText(token)).toBe(false);
	});
});
