import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../test/auth-doubles.js';
import { AuthErrorCode } from './errors.js';
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

describe('isTokenText', () => {
	it.each(['ghu_abc', 'glpat-x.y_z'])('accepts %j', (token) => {
		expect(isTokenText(token)).toBe(true);
	});

	it.each(['', 'a b', 'a\r\nX-Injected: 1', 'é', 'x'.repeat(4097), 5, null])('refuses %j', (token) => {
		expect(isTokenText(token)).toBe(false);
	});
});
