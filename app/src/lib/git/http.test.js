import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from './errors.js';
import { authCallbacks, createGitHttp, toRelayUrl, withSignal } from './http.js';

const RELAY = 'https://relay.example';

describe('toRelayUrl', () => {
	it('puts the host and repo path under /api/git', () => {
		expect(toRelayUrl('https://github.com/o/r.git/info/refs?service=git-upload-pack', RELAY)).toBe(
			'https://relay.example/api/git/github.com/o/r.git/info/refs?service=git-upload-pack'
		);
		expect(toRelayUrl('https://gitlab.com/g/s/r.git/git-receive-pack', RELAY)).toBe(
			'https://relay.example/api/git/gitlab.com/g/s/r.git/git-receive-pack'
		);
	});

	it('keeps a test host port, and lowercases the host', () => {
		expect(toRelayUrl('http://LOCALHOST:8175/o/r.git/git-upload-pack', RELAY)).toBe(
			'https://relay.example/api/git/localhost:8175/o/r.git/git-upload-pack'
		);
	});

	it('uses only the origin of the relay address', () => {
		expect(toRelayUrl('https://github.com/o/r.git/git-upload-pack', 'https://relay.example/some/page')).toBe(
			'https://relay.example/api/git/github.com/o/r.git/git-upload-pack'
		);
	});

	it('refuses other protocols', () => {
		expect(() => toRelayUrl('ssh://github.com/o/r.git', RELAY)).toThrow(TypeError);
		expect(() => toRelayUrl('file:///etc/passwd', RELAY)).toThrow(TypeError);
	});

	it('refuses credentials in the URL, which would reach the relay in the path', () => {
		expect(() => toRelayUrl('https://user:token@github.com/o/r.git', RELAY)).toThrow(/credentials/);
	});
});

describe('createGitHttp', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('needs an origin outside a browser page', () => {
		expect(() => createGitHttp()).toThrow(TypeError);
	});

	it('reports a failed fetch as a network error', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('Failed to fetch');
		});
		const http = createGitHttp({ relayOrigin: RELAY });
		await expect(http.request({ url: 'https://github.com/o/r.git/info/refs' })).rejects.toMatchObject({ code: ErrorCode.NETWORK });
	});

	it('reports a connection lost while the body arrives as a network error', async () => {
		const body = new ReadableStream({
			pull(controller) {
				controller.error(new TypeError('network error'));
			}
		});
		vi.stubGlobal('fetch', async () => new Response(body));
		const response = await createGitHttp({ relayOrigin: RELAY }).request({ url: 'https://github.com/o/r.git/info/refs' });
		const read = /** @type {AsyncIterableIterator<Uint8Array>} */ (response.body).next();
		await expect(read).rejects.toMatchObject({ code: ErrorCode.NETWORK });
	});

	// A fetch that never answers until its signal aborts.
	const silentFetch = (/** @type {string} */ _url, /** @type {RequestInit} */ init) =>
		new Promise((_resolve, reject) => {
			init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
		});

	it('ends a request nobody answers in a network error', async () => {
		vi.stubGlobal('fetch', silentFetch);
		const http = createGitHttp({ relayOrigin: RELAY, stallTimeoutMs: 20 });
		await expect(http.request({ url: 'https://github.com/o/r.git/info/refs' })).rejects.toMatchObject({ code: ErrorCode.NETWORK });
	});

	it('gives a large upload longer to be answered', async () => {
		vi.stubGlobal('fetch', silentFetch);
		const http = createGitHttp({ relayOrigin: RELAY, stallTimeoutMs: 20 });
		const body = [new Uint8Array(8_000)];
		const settled = vi.fn();
		const request = http.request({ url: 'https://github.com/o/r.git/git-receive-pack', method: 'POST', body: /** @type {never} */ (body) }).catch(settled);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(settled).not.toHaveBeenCalled();
		await request;
		expect(settled.mock.calls[0][0]).toMatchObject({ code: ErrorCode.NETWORK });
	}, 5_000);

	it('ends a response body that goes quiet in a network error', async () => {
		vi.stubGlobal('fetch', async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1]));
					init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
				}
			});
			return new Response(body);
		});
		const response = await createGitHttp({ relayOrigin: RELAY, stallTimeoutMs: 20 }).request({ url: 'https://github.com/o/r.git/info/refs' });
		const reader = /** @type {AsyncIterableIterator<Uint8Array>} */ (response.body);
		expect([...(await reader.next()).value]).toEqual([1]);
		await expect(reader.next()).rejects.toMatchObject({ code: ErrorCode.NETWORK });
	});

	it('does not count a slow reader as a stalled connection', async () => {
		vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1])));
		const response = await createGitHttp({ relayOrigin: RELAY, stallTimeoutMs: 20 }).request({ url: 'https://github.com/o/r.git/info/refs' });
		const reader = /** @type {AsyncIterableIterator<Uint8Array>} */ (response.body);
		await reader.next();
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect((await reader.next()).done).toBe(true);
	});

	it('still reports a cancel as a cancel', async () => {
		vi.stubGlobal('fetch', silentFetch);
		const controller = new AbortController();
		const request = createGitHttp({ relayOrigin: RELAY }).request({ url: 'https://github.com/o/r.git/info/refs', signal: controller.signal });
		const reason = new DOMException('stopped', 'AbortError');
		controller.abort(reason);
		await expect(request).rejects.toBe(reason);
	});

	it('keeps a bad URL a TypeError, not a network problem', async () => {
		const http = createGitHttp({ relayOrigin: RELAY });
		await expect(http.request({ url: 'ssh://github.com/o/r.git' })).rejects.toBeInstanceOf(TypeError);
	});
});

describe('withSignal', () => {
	it('aborts a request through the relay client', async () => {
		const controller = new AbortController();
		controller.abort();
		const http = withSignal(createGitHttp({ relayOrigin: 'http://127.0.0.1:9' }), controller.signal);
		await expect(http.request({ url: 'https://github.com/o/r.git/info/refs' })).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('returns the client unchanged without a signal', () => {
		const http = createGitHttp({ relayOrigin: RELAY });
		expect(withSignal(http, undefined)).toBe(http);
	});
});

describe('authCallbacks', () => {
	it('adds nothing without a credential source', () => {
		expect(authCallbacks(undefined)).toEqual({});
	});

	it('asks for the credential, then once more after a refusal', async () => {
		/** @type {boolean[]} */
		const failedFlags = [];
		const { onAuth, onAuthFailure } = authCallbacks(({ failed }) => {
			failedFlags.push(failed);
			return { username: 'oauth2', password: failed ? 'fresh' : 'stale' };
		});

		expect(await onAuth?.('u')).toEqual({ username: 'oauth2', password: 'stale' });
		expect(await onAuthFailure?.('u')).toEqual({ username: 'oauth2', password: 'fresh' });
		expect(await onAuthFailure?.('u')).toBeUndefined();
		expect(failedFlags).toEqual([false, true]);
	});

	it('answers nothing when the source has no credential', async () => {
		const { onAuth } = authCallbacks(() => null);
		expect(await onAuth?.('u')).toBeUndefined();
	});
});
