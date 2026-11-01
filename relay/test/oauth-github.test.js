import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { GITHUB_TOKEN_URL } from '../src/oauth-github.js';
import { relay, spyConsole, stubUpstream } from './helpers.js';

const VERIFIER = 'a'.repeat(43);
const TOKEN_JSON = {
	access_token: 'ghu_accesstoken',
	expires_in: 28800,
	refresh_token: 'ghr_refreshtoken',
	refresh_token_expires_in: 15724800,
	scope: '',
	token_type: 'bearer'
};

/**
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<Response>}
 */
function postJson(path, body) {
	return relay(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('POST /api/oauth/github/token', () => {
	it('exchanges the code with the App credentials and returns the token JSON uncached', async () => {
		const logged = spyConsole();
		const calls = stubUpstream(() => Response.json(TOKEN_JSON));
		const response = await postJson('/api/oauth/github/token', {
			code: 'abc123',
			code_verifier: VERIFIER,
			redirect_uri: 'gitnote://oauth/callback'
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual(TOKEN_JSON);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(GITHUB_TOKEN_URL);
		expect(calls[0].init.redirect).toBe('manual');
		expect(calls[0].headers.get('accept')).toBe('application/json');
		const sent = Object.fromEntries(new URLSearchParams(String(calls[0].init.body)));
		expect(sent).toEqual({
			code: 'abc123',
			code_verifier: VERIFIER,
			redirect_uri: 'gitnote://oauth/callback',
			client_id: 'test-client-id',
			client_secret: 'test-client-secret'
		});
		expect(logged()).toEqual([]);
	});

	it.each([
		[{}],
		[{ code: '' }],
		[{ code: 42 }],
		[{ code: 'abc&client_id=evil' }],
		[{ code: 'abc', code_verifier: 'short' }],
		[{ code: 'abc', redirect_uri: 'not a url' }],
		[[]],
		['abc']
	])('answers 400 without calling GitHub for %j', async (body) => {
		const calls = stubUpstream(() => Response.json(TOKEN_JSON));
		const response = await postJson('/api/oauth/github/token', body);
		expect(response.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it('answers 400 for a body that is not JSON', async () => {
		const response = await relay('/api/oauth/github/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{'
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: 'invalid_json' });
	});

	it('answers 415 for a non-JSON content type', async () => {
		const response = await relay('/api/oauth/github/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'code=abc'
		});
		expect(response.status).toBe(415);
	});

	it('answers 413 for an oversized body', async () => {
		const calls = stubUpstream(() => Response.json(TOKEN_JSON));
		const response = await postJson('/api/oauth/github/token', { code: 'abc', padding: 'x'.repeat(9000) });
		expect(response.status).toBe(413);
		expect(calls).toHaveLength(0);
	});

	it("relays GitHub's error code as a 400", async () => {
		stubUpstream(() =>
			Response.json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' })
		);
		const response = await postJson('/api/oauth/github/token', { code: 'expired' });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: 'bad_verification_code',
			message: 'The code passed is incorrect or expired.'
		});
	});

	it('answers 502 when GitHub returns no token or cannot be reached', async () => {
		stubUpstream(() => new Response('<html>busy</html>', { status: 503 }));
		const busy = await postJson('/api/oauth/github/token', { code: 'abc' });
		stubUpstream(() => Response.json({ token_type: 'bearer' }));
		const empty = await postJson('/api/oauth/github/token', { code: 'abc' });
		stubUpstream(() => {
			throw new TypeError('network down');
		});
		const down = await postJson('/api/oauth/github/token', { code: 'abc' });
		expect([busy.status, empty.status, down.status]).toEqual([502, 502, 502]);
	});

	it('answers 503 when the App credentials are not configured', async () => {
		const calls = stubUpstream(() => Response.json(TOKEN_JSON));
		const limiter = { limit: async () => ({ success: true }) };
		const response = await app.request(
			'https://gitnote.test/api/oauth/github/token',
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'abc' }) },
			{ API_LIMITER: limiter, OAUTH_LIMITER: limiter, CORS_ORIGINS: '', GIT_HOSTS: '' }
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: 'oauth_not_configured' });
		expect(calls).toHaveLength(0);
	});
});

describe('POST /api/oauth/github/refresh', () => {
	it('refreshes with the App credentials and never logs the tokens', async () => {
		const logged = spyConsole();
		const calls = stubUpstream(() => Response.json(TOKEN_JSON));
		const response = await postJson('/api/oauth/github/refresh', { refresh_token: 'ghr_oldrefresh' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(TOKEN_JSON);
		expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({
			grant_type: 'refresh_token',
			refresh_token: 'ghr_oldrefresh',
			client_id: 'test-client-id',
			client_secret: 'test-client-secret'
		});
		expect(logged()).toEqual([]);
	});

	it('answers 400 for a missing refresh token', async () => {
		const calls = stubUpstream(() => Response.json(TOKEN_JSON));
		const response = await postJson('/api/oauth/github/refresh', { refresh_token: '' });
		expect(response.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it('only accepts POST', async () => {
		const response = await relay('/api/oauth/github/refresh');
		expect(response.status).toBe(404);
	});
});
