/* global IdentityTransformStream -- a Workers runtime global missing from the eslint `worker` globals */
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { GITHUB_TOKEN_URL, readCapped } from '../src/oauth-github.js';
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

	it('answers 411 for a streamed body without Content-Length, before reading it', async () => {
		const calls = stubUpstream(() => Response.json(TOKEN_JSON));
		// A native stream of unknown length, larger than the cap: the request
		// carries no Content-Length and must be refused without buffering it.
		const { readable, writable } = new IdentityTransformStream();
		const writer = writable.getWriter();
		const written = writer
			.write(new TextEncoder().encode(`{"code":"abc","padding":"${'x'.repeat(20_000)}"}`))
			.then(() => writer.close())
			.catch(() => {});
		const response = await relay('/api/oauth/github/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: readable
		});
		expect(response.status).toBe(411);
		expect(await response.json()).toMatchObject({ error: 'length_required' });
		expect(calls).toHaveLength(0);
		await written;
	});

	it('answers 400 for a body that is not UTF-8', async () => {
		const calls = stubUpstream(() => Response.json(TOKEN_JSON));
		const response = await relay('/api/oauth/github/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: new Uint8Array([0x7b, 0xff, 0x7d])
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: 'invalid_json' });
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
			// In-process requests carry no Content-Length unless set, unlike real HTTP ones.
			{ method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '14' }, body: '{"code":"abc"}' },
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

describe('capped body reads', () => {
	/**
	 * An endless body of 1 KB chunks that counts how many were pulled and
	 * whether the reader cancelled it.
	 * @returns {{ stream: ReadableStream<Uint8Array>, state: { pulls: number, cancelled: boolean } }}
	 */
	function endlessBody() {
		const state = { pulls: 0, cancelled: false };
		const stream = new ReadableStream(
			{
				pull(controller) {
					state.pulls += 1;
					controller.enqueue(new Uint8Array(1024));
				},
				cancel() {
					state.cancelled = true;
				}
			},
			{ highWaterMark: 0 }
		);
		return { stream, state };
	}

	it('stops and cancels the stream at the first chunk past the limit', async () => {
		const { stream, state } = endlessBody();
		expect(await readCapped(stream, 8192)).toBe('too_large');
		expect(state.cancelled).toBe(true);
		expect(state.pulls).toBe(9);
	});

	it('returns every byte of a body within the limit', async () => {
		const parts = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
		const stream = new ReadableStream({
			start(controller) {
				for (const part of parts) controller.enqueue(part);
				controller.close();
			}
		});
		expect(await readCapped(stream, 6)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
	});

	it('treats a missing body as empty and a failing one as unreadable', async () => {
		expect(await readCapped(null, 10)).toEqual(new Uint8Array(0));
		const failing = new ReadableStream({
			pull(controller) {
				controller.error(new Error('connection reset'));
			}
		});
		expect(await readCapped(failing, 10)).toBe('unreadable');
	});
});
