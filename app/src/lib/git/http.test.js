import { describe, expect, it } from 'vitest';
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
	it('needs an origin outside a browser page', () => {
		expect(() => createGitHttp()).toThrow(TypeError);
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
