/* global IdentityTransformStream -- a Workers runtime global missing from the eslint `worker` globals */
import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, parseGitHosts, resolveGitTarget } from '../src/git-proxy.js';
import { relay, spyConsole, stubUpstream } from './helpers.js';

const UPLOAD_PACK = 'application/x-git-upload-pack-request';
const REFS_PATH = '/api/git/github.com/octo/notes.git/info/refs?service=git-upload-pack';

/**
 * @param {string} [body]
 * @returns {Response}
 */
function gitResponse(body = '001e# service=git-upload-pack\n0000') {
	return new Response(body, {
		headers: {
			'Content-Type': 'application/x-git-upload-pack-advertisement',
			'Cache-Control': 'no-cache',
			'Set-Cookie': 'session=upstream',
			'WWW-Authenticate': 'Basic realm="GitHub"'
		}
	});
}

/**
 * @returns {Response} an upload-pack result as a git host sends it
 */
function packResult() {
	return new Response('0008NAK\n', { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
}

/**
 * Reads the request bodies the loopback git host fixture saw for one repo path.
 * @param {string} path
 * @returns {Promise<import('./upstream-fixture.js').ReceivedBody[]>}
 */
async function fixtureReceived(path) {
	const response = await fetch(`http://localhost:8174/__received?path=${encodeURIComponent(path)}`);
	return response.json();
}

/**
 * Reads a git (binary) response body as text without the runtime's
 * non-text-body warning.
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function bodyText(response) {
	return new TextDecoder().decode(await response.arrayBuffer());
}

describe('git host allowlist', () => {
	it('parses hosts, uses http only for loopback and drops malformed entries', () => {
		const hosts = parseGitHosts(' GitHub.com , gitlab.com,localhost:8174,127.0.0.1:9,https://evil.test,a/b,');
		expect([...hosts]).toEqual([
			['github.com', 'https://github.com'],
			['gitlab.com', 'https://gitlab.com'],
			['localhost:8174', 'http://localhost:8174'],
			['127.0.0.1:9', 'http://127.0.0.1:9']
		]);
	});

	it.each([
		'/api/git/example.com/octo/notes.git/info/refs?service=git-upload-pack',
		'/api/git/github.com.evil.test/octo/notes.git/info/refs?service=git-upload-pack',
		'/api/git/localhost:9999/octo/notes.git/info/refs?service=git-upload-pack',
		'/api/git/user@github.com/octo/notes.git/info/refs?service=git-upload-pack',
		'/api/git/169.254.169.254/latest/meta-data.git/info/refs?service=git-upload-pack'
	])('answers 403 without any upstream call for %s', async (path) => {
		const calls = stubUpstream(() => gitResponse());
		const response = await relay(path);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: 'git_target_not_allowed' });
		expect(calls).toHaveLength(0);
	});
});

describe('git path allowlist', () => {
	const hosts = parseGitHosts('github.com,gitlab.com,localhost:8174');

	it('maps the three git endpoints, nested GitLab groups and loopback fixtures', () => {
		const at = (/** @type {string} */ path) => resolveGitTarget(new URL(path, 'https://gitnote.test'), hosts);
		expect(at(REFS_PATH)).toEqual({
			method: 'GET',
			url: 'https://github.com/octo/notes.git/info/refs?service=git-upload-pack',
			responseType: 'application/x-git-upload-pack-advertisement'
		});
		expect(at('/api/git/gitlab.com/group/sub/notes.git/git-receive-pack')).toEqual({
			method: 'POST',
			url: 'https://gitlab.com/group/sub/notes.git/git-receive-pack',
			contentType: 'application/x-git-receive-pack-request',
			responseType: 'application/x-git-receive-pack-result'
		});
		expect(at('/api/git/localhost:8174/me/.github.git/git-upload-pack')).toEqual({
			method: 'POST',
			url: 'http://localhost:8174/me/.github.git/git-upload-pack',
			contentType: UPLOAD_PACK,
			responseType: 'application/x-git-upload-pack-result'
		});
	});

	it.each([
		['GET', '/api/git/github.com/octo/notes.git/HEAD'],
		['GET', '/api/git/github.com/octo/notes.git/objects/info/packs'],
		['GET', '/api/git/github.com/octo/notes.git/info/refs'],
		['GET', '/api/git/github.com/octo/notes.git/info/refs?service=git-upload-archive'],
		['GET', '/api/git/github.com/octo/notes.git/info/refs?service=git-upload-pack&x=1'],
		['GET', '/api/git/github.com/octo/notes/info/refs?service=git-upload-pack'],
		['GET', '/api/git/github.com/notes.git/info/refs?service=git-upload-pack'],
		['GET', '/api/git/github.com/octo/%2e%2e/notes.git/info/refs?service=git-upload-pack'],
		['GET', '/api/git/github.com/octo//notes.git/info/refs?service=git-upload-pack'],
		['GET', '/api/git/github.com/octo/notes.git/git-upload-pack'],
		['POST', '/api/git/github.com/octo/notes.git/info/refs?service=git-upload-pack'],
		['POST', '/api/git/github.com/octo/notes.git/git-upload-pack?x=1'],
		['GET', '/api/git/github.com/login/oauth/access_token'],
		['GET', '/api/git/github.com/octocat/Hello-World/blob/master/x.git/info/refs?service=git-upload-pack'],
		['GET', '/api/git/github.com/octo/notes/raw/x.git/info/refs?service=git-upload-pack'],
		['POST', '/api/git/github.com/group/sub/notes.git/git-upload-pack'],
		['GET', '/api/git/gitlab.com/group/notes/-/raw/main/x.git/info/refs?service=git-upload-pack'],
		['GET', '/api/git/gitlab.com/group/-/notes.git/info/refs?service=git-upload-pack'],
		['GET', '/api/git/']
	])('answers 403 without any upstream call for %s %s', async (method, path) => {
		const calls = stubUpstream(() => gitResponse());
		const init = method === 'POST' ? { method, body: '0000', headers: { 'Content-Type': UPLOAD_PACK } } : { method };
		const response = await relay(path, init);
		expect(response.status).toBe(403);
		expect(calls).toHaveLength(0);
	});

	it('answers 403 for a POST with the wrong content type', async () => {
		const calls = stubUpstream(() => gitResponse());
		const response = await relay('/api/git/github.com/octo/notes.git/git-upload-pack', {
			method: 'POST',
			body: '0000',
			headers: { 'Content-Type': 'application/x-git-receive-pack-request' }
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: 'git_content_type_not_allowed' });
		expect(calls).toHaveLength(0);
	});
});

describe('request body limits', () => {
	it('answers 413 with the limit for a Content-Length over 95 MB, before any upstream call', async () => {
		const calls = stubUpstream(() => gitResponse());
		const response = await relay('/api/git/github.com/octo/notes.git/git-receive-pack', {
			method: 'POST',
			body: '0000',
			headers: {
				'Content-Type': 'application/x-git-receive-pack-request',
				'Content-Length': String(MAX_BODY_BYTES + 1)
			}
		});
		expect(response.status).toBe(413);
		const body = await response.json();
		expect(body).toMatchObject({ error: 'payload_too_large', limit: 95_000_000 });
		expect(body.message).toContain('95 MB');
		expect(calls).toHaveLength(0);
	});

	it('answers 411 for a POST without Content-Length', async () => {
		const calls = stubUpstream(() => gitResponse());
		// A native stream of unknown length: the request carries no Content-Length.
		// The test owns the writer, so the unread body ends here instead of as a
		// runtime pipe error in a later test.
		const { readable, writable } = new IdentityTransformStream();
		const writer = writable.getWriter();
		const written = writer
			.write(new TextEncoder().encode('0000'))
			.then(() => writer.close())
			.catch(() => {});
		const response = await relay('/api/git/github.com/octo/notes.git/git-upload-pack', {
			method: 'POST',
			body: readable,
			headers: { 'Content-Type': UPLOAD_PACK }
		});
		expect(response.status).toBe(411);
		expect(calls).toHaveLength(0);
		await written;
	});

	it('streams an allowed POST body upstream with its length', async () => {
		const payload = new Uint8Array(70_000).map((_, i) => i % 251);
		/** @type {Uint8Array | undefined} */
		let received;
		const calls = stubUpstream(async ({ init }) => {
			received = new Uint8Array(await new Response(init.body).arrayBuffer());
			return new Response('0008NAK\n', { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
		});
		const response = await relay('/api/git/gitlab.com/group/sub/notes.git/git-upload-pack', {
			method: 'POST',
			body: payload,
			headers: { 'Content-Type': UPLOAD_PACK, Accept: 'application/x-git-upload-pack-result' }
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/x-git-upload-pack-result');
		expect(await bodyText(response)).toBe('0008NAK\n');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://gitlab.com/group/sub/notes.git/git-upload-pack');
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].init.body).toBeInstanceOf(ReadableStream);
		expect(received).toEqual(payload);
	});
});

describe('request body encoding', () => {
	it('forwards a gzip body unchanged with its Content-Encoding', async () => {
		const plain = new TextEncoder().encode('0032want 0123456789012345678901234567890123456789\n'.repeat(200));
		const gzip = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
		/** @type {Uint8Array | undefined} */
		let received;
		const calls = stubUpstream(async ({ init }) => {
			received = new Uint8Array(await new Response(init.body).arrayBuffer());
			return new Response('0008NAK\n', { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } });
		});
		const response = await relay('/api/git/gitlab.com/group/notes.git/git-upload-pack', {
			method: 'POST',
			body: gzip,
			headers: { 'Content-Type': UPLOAD_PACK, 'Content-Encoding': 'gzip' }
		});
		expect(response.status).toBe(200);
		await response.arrayBuffer();
		expect(calls).toHaveLength(1);
		expect(calls[0].headers.get('content-encoding')).toBe('gzip');
		expect(received).toEqual(gzip);
	});

	it('forwards an identity Content-Encoding', async () => {
		const calls = stubUpstream(() => packResult());
		const response = await relay('/api/git/github.com/octo/notes.git/git-upload-pack', {
			method: 'POST',
			body: '0000',
			headers: { 'Content-Type': UPLOAD_PACK, 'Content-Encoding': 'Identity' }
		});
		expect(response.status).toBe(200);
		await response.arrayBuffer();
		expect(calls[0].headers.get('content-encoding')).toBe('identity');
	});

	it('sends no Content-Encoding upstream when the client sent none', async () => {
		const calls = stubUpstream(() => packResult());
		const response = await relay('/api/git/github.com/octo/notes.git/git-upload-pack', {
			method: 'POST',
			body: '0000',
			headers: { 'Content-Type': UPLOAD_PACK }
		});
		expect(response.status).toBe(200);
		await response.arrayBuffer();
		expect(calls[0].headers.has('content-encoding')).toBe(false);
	});

	it.each(['br', 'deflate', 'zstd', 'gzip, br'])('answers 415 for Content-Encoding %s before any upstream call', async (encoding) => {
		const calls = stubUpstream(() => gitResponse());
		const response = await relay('/api/git/github.com/octo/notes.git/git-upload-pack', {
			method: 'POST',
			body: '0000',
			headers: { 'Content-Type': UPLOAD_PACK, 'Content-Encoding': encoding }
		});
		expect(response.status).toBe(415);
		expect(await response.json()).toMatchObject({ error: 'unsupported_content_encoding' });
		expect(calls).toHaveLength(0);
	});
});

describe('forwarded headers', () => {
	it('forwards Authorization and never logs it', async () => {
		const token = 'Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldF90b2tlbg==';
		const logged = spyConsole();
		const calls = stubUpstream(() => gitResponse());
		const response = await relay(REFS_PATH, {
			headers: { Authorization: token, 'Git-Protocol': 'version=2', Accept: '*/*' }
		});
		expect(response.status).toBe(200);
		await bodyText(response);
		expect(calls[0].headers.get('authorization')).toBe(token);
		expect(calls[0].headers.get('git-protocol')).toBe('version=2');
		expect(calls[0].headers.get('accept')).toBe('*/*');
		expect(logged()).toEqual([]);
	});

	it('drops Cookie, cf-* and every other header not on the allowlist', async () => {
		const calls = stubUpstream(() => gitResponse());
		await relay(REFS_PATH, {
			headers: {
				Cookie: 'session=browser',
				'CF-Connecting-IP': '198.51.100.7',
				'CF-Ray': 'abc',
				'X-Forwarded-For': '198.51.100.7',
				Origin: 'https://gitnote.test',
				Referer: 'https://gitnote.test/notes'
			}
		});
		expect([...calls[0].headers.keys()].sort()).toEqual(['user-agent']);
	});

	it('gives the host a git User-Agent unless the client sent one', async () => {
		const calls = stubUpstream(() => gitResponse());
		await relay(REFS_PATH, { headers: { 'User-Agent': 'Mozilla/5.0' } });
		await relay(REFS_PATH, { headers: { 'User-Agent': 'git/isomorphic-git@1.44.8' } });
		expect(calls.map((call) => call.headers.get('user-agent'))).toEqual([
			'git/gitnote-relay',
			'git/isomorphic-git@1.44.8'
		]);
	});

	it('returns only safe response headers, without Set-Cookie or WWW-Authenticate', async () => {
		stubUpstream(() => gitResponse());
		const response = await relay(REFS_PATH);
		expect(response.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement');
		expect(response.headers.get('cache-control')).toBe('no-cache');
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(response.headers.get('www-authenticate')).toBeNull();
		expect(await bodyText(response)).toBe('001e# service=git-upload-pack\n0000');
	});

	it('passes an upstream 401 through as 401', async () => {
		stubUpstream(() => new Response('denied', { status: 401, headers: { 'WWW-Authenticate': 'Basic' } }));
		const response = await relay(REFS_PATH);
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBeNull();
	});
});

describe('upstream response types', () => {
	const page = '<!doctype html><script>alert(document.domain)</script>';

	it('answers a JSON 502 instead of relaying an HTML page with a 200', async () => {
		stubUpstream(() => new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
		const response = await relay(REFS_PATH);
		expect(response.status).toBe(502);
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(await response.json()).toMatchObject({ error: 'unexpected_upstream_response' });
	});

	it('answers a JSON 502 for a 200 carrying the other git service type', async () => {
		stubUpstream(() => new Response('0000', { headers: { 'Content-Type': 'application/x-git-receive-pack-advertisement' } }));
		const response = await relay(REFS_PATH);
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: 'unexpected_upstream_response' });
	});

	it('keeps the status but not the body of an HTML error page', async () => {
		stubUpstream(() => new Response(page, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
		const response = await relay(REFS_PATH);
		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).toBe('application/json');
		const text = await response.text();
		expect(text).not.toContain('<script>');
		expect(JSON.parse(text)).toMatchObject({ error: 'upstream_error' });
	});

	it('relays a plain-text git host error as it came', async () => {
		stubUpstream(() => new Response('HTTP Basic: Access denied', { status: 403, headers: { 'Content-Type': 'text/plain' } }));
		const response = await relay(REFS_PATH);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe('HTTP Basic: Access denied');
	});

	it('marks every relayed answer nosniff and sandboxed', async () => {
		stubUpstream(() => gitResponse());
		const response = await relay(REFS_PATH);
		expect(response.status).toBe(200);
		await bodyText(response);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox; frame-ancestors 'none'");
	});
});

describe('request bodies on the wire', () => {
	it('sends the upstream host a fixed Content-Length, not chunked encoding', async () => {
		const path = '/me/fixed-length.git';
		const payload = new Uint8Array(70_000).map((_, i) => i % 251);
		// A native stream, so the relay cannot know the length from the body itself.
		const { readable, writable } = new IdentityTransformStream();
		const writer = writable.getWriter();
		const written = writer.write(payload).then(() => writer.close());
		const response = await relay(`/api/git/localhost:8174${path}/git-upload-pack`, {
			method: 'POST',
			body: readable,
			headers: { 'Content-Type': UPLOAD_PACK, 'Content-Length': String(payload.length) }
		});
		await written;
		expect(response.status).toBe(200);
		expect(await bodyText(response)).toBe('0008NAK\n');
		expect(await fixtureReceived(path)).toEqual([
			{ contentLength: '70000', transferEncoding: null, bytes: 70_000, complete: true }
		]);
	});

	it('aborts the upstream request when the client body ends short of its Content-Length', async () => {
		const path = '/me/short-body.git';
		const { readable, writable } = new IdentityTransformStream();
		const writer = writable.getWriter();
		const written = writer
			.write(new Uint8Array(1000))
			.then(() => writer.close())
			.catch(() => {});
		const response = await relay(`/api/git/localhost:8174${path}/git-upload-pack`, {
			method: 'POST',
			body: readable,
			headers: { 'Content-Type': UPLOAD_PACK, 'Content-Length': '5000' }
		});
		await written;
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: 'upstream_unreachable' });
		// The host never saw a whole body, so it never handled a truncated pack.
		const records = await fixtureReceived(path);
		expect(records.every((record) => !record.complete && record.bytes < 5000)).toBe(true);
	});
});

describe('upstream redirects and failures', () => {
	it('turns an upstream 301 into a JSON 502 without following or logging it', async () => {
		const location = 'https://github.com/octo/renamed.git/info/refs?service=git-upload-pack';
		const logged = spyConsole();
		const calls = stubUpstream(() => new Response(null, { status: 301, headers: { Location: location } }));
		const response = await relay(REFS_PATH, { headers: { Authorization: 'Bearer secret' } });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: 'repo_moved', location });
		expect(calls).toHaveLength(1);
		expect(calls[0].init.redirect).toBe('manual');
		expect(logged()).toEqual([]);
	});

	it('answers 502 when the git host cannot be reached, logging nothing', async () => {
		const logged = spyConsole();
		stubUpstream(() => {
			throw new TypeError('network down');
		});
		const response = await relay(REFS_PATH, { headers: { Authorization: 'Bearer secret' } });
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: 'upstream_unreachable' });
		expect(logged()).toEqual([]);
	});
});
