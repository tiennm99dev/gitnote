/* global FixedLengthStream -- a Workers runtime global missing from the eslint `worker` globals */
import { jsonError } from './json-error.js';

/**
 * Largest request body the relay forwards: the `miti99.dev` zone caps request
 * bodies at 100 MB, so a push pack must stay under that with some headroom.
 */
export const MAX_BODY_BYTES = 95_000_000;

/** Route prefix in front of `<host>/<repo path>.git/<git endpoint>`. */
const PREFIX = '/api/git/';

/** Request headers forwarded upstream; everything else (Cookie, cf-*, X-Forwarded-*) is dropped. */
const FORWARD_REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'git-protocol', 'user-agent'];

/**
 * Response headers passed back to the client. `WWW-Authenticate` is dropped so
 * a 401 never pops up the browser's own login dialog (the app asks for the
 * token itself), and `Set-Cookie` never reaches the app origin.
 */
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'expires', 'pragma'];

/**
 * GitHub and GitLab answer git clients by `User-Agent`; one that does not
 * start with `git/` can get a browser-oriented response instead.
 */
const DEFAULT_USER_AGENT = 'git/gitnote-relay';

/**
 * Request body encodings forwarded with the body. Native git gzips larger
 * upload-pack negotiations; the host must see that label to decode them. Any
 * other encoding is refused, so the host never gets bytes it cannot read.
 */
const FORWARD_CONTENT_ENCODINGS = new Set(['gzip', 'identity']);

const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);
const HOST_ENTRY = /^[a-z0-9.-]+(:\d{1,5})?$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Hosts whose repositories always sit at `<owner>/<repo>.git`. Any deeper path
 * there is a web page (blob, raw, issues), never a repository.
 */
const FLAT_REPO_HOSTS = new Set(['github.com']);

/**
 * GitLab's route separator: `/-/` starts its web routes (`/-/raw/`,
 * `/-/blob/`), and no group or project may be named `-`.
 */
const ROUTE_SEPARATOR = '-';

/**
 * @typedef {object} GitTarget
 * @property {string} url upstream URL to fetch
 * @property {'GET' | 'POST'} method
 * @property {string} [contentType] the content type a POST must carry
 * @property {string} responseType the content type a successful answer carries
 */

/**
 * Parses the `GIT_HOSTS` var: comma-separated `host` or `host:port` entries.
 * Loopback hosts are reached over http (local test fixtures); every other
 * host over https. Malformed entries are ignored.
 * @param {string | undefined} value
 * @returns {Map<string, string>} host entry to its `scheme://host` base URL
 */
export function parseGitHosts(value) {
	/** @type {Map<string, string>} */
	const hosts = new Map();
	for (const raw of (value ?? '').split(',')) {
		const entry = raw.trim().toLowerCase();
		if (!HOST_ENTRY.test(entry)) continue;
		const hostname = entry.replace(/:\d+$/, '');
		const scheme = LOOPBACK_HOSTS.has(hostname) ? 'http' : 'https';
		hosts.set(entry, `${scheme}://${entry}`);
	}
	return hosts;
}

/**
 * Maps a relay URL onto an allowed upstream git smart-HTTP endpoint, or
 * returns null when the host, repo path, endpoint or query is not allowed.
 * @param {URL} url the incoming request URL
 * @param {Map<string, string>} hosts from {@link parseGitHosts}
 * @returns {GitTarget | null}
 */
export function resolveGitTarget(url, hosts) {
	if (!url.pathname.startsWith(PREFIX)) return null;
	const [host, ...rest] = url.pathname.slice(PREFIX.length).split('/');
	const base = hosts.get(host.toLowerCase());
	if (base === undefined) return null;

	/** @type {Omit<GitTarget, 'url'> & { endpoint: string }} */
	let target;
	const tail = rest.slice(-2).join('/');
	if (tail === 'info/refs') {
		const service = url.searchParams.get('service');
		if ([...url.searchParams.keys()].length !== 1 || service === null || !SERVICES.has(service)) {
			return null;
		}
		target = {
			method: 'GET',
			endpoint: `info/refs?service=${service}`,
			responseType: `application/x-${service}-advertisement`
		};
		rest.splice(-2);
	} else if (SERVICES.has(rest.at(-1) ?? '')) {
		if (url.search !== '') return null;
		const service = /** @type {string} */ (rest.pop());
		target = {
			method: 'POST',
			endpoint: service,
			contentType: `application/x-${service}-request`,
			responseType: `application/x-${service}-result`
		};
	} else {
		return null;
	}

	// `<owner>/<repo>.git`, or `<group>/<subgroup>/.../<repo>.git` on GitLab.
	if (rest.length < 2 || !rest.at(-1)?.endsWith('.git')) return null;
	const hostname = host.toLowerCase().replace(/:\d+$/, '');
	if (FLAT_REPO_HOSTS.has(hostname) && rest.length !== 2) return null;
	const isRepoSegment = (/** @type {string} */ segment) =>
		PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..' && segment !== ROUTE_SEPARATOR;
	if (!rest.every(isRepoSegment)) return null;

	const { endpoint, ...request } = target;
	return { ...request, url: `${base}/${rest.join('/')}/${endpoint}` };
}

/**
 * Relays one git smart-HTTP request to an allowlisted host. Bodies stream in
 * both directions without buffering. Nothing about the request is stored or
 * logged.
 * @param {import('./app-env.js').AppContext} c
 * @returns {Promise<Response>}
 */
export async function gitProxy(c) {
	const request = c.req.raw;
	const target = resolveGitTarget(new URL(request.url), parseGitHosts(c.env.GIT_HOSTS));
	if (target === null) {
		return jsonError(403, 'git_target_not_allowed', 'The relay only reaches git smart-HTTP endpoints on allowed hosts.');
	}
	if (request.method !== target.method) {
		return jsonError(403, 'git_method_not_allowed', `This git endpoint only accepts ${target.method}.`);
	}

	const headers = forwardHeaders(request.headers);
	/** @type {RequestInit} */
	const init = { method: target.method, headers, redirect: 'manual' };

	if (target.method === 'POST') {
		const contentType = request.headers.get('Content-Type')?.trim().toLowerCase();
		if (contentType !== target.contentType) {
			return jsonError(403, 'git_content_type_not_allowed', `This git endpoint needs Content-Type ${target.contentType}.`);
		}
		const encoding = request.headers.get('Content-Encoding')?.trim().toLowerCase();
		if (encoding !== undefined) {
			if (!FORWARD_CONTENT_ENCODINGS.has(encoding)) {
				return jsonError(415, 'unsupported_content_encoding', 'Git request bodies must be uncompressed or gzip.');
			}
			headers.set('content-encoding', encoding);
		}
		const length = parseContentLength(request.headers.get('Content-Length'));
		if (length === undefined) {
			return jsonError(411, 'length_required', 'Git requests through the relay need a Content-Length header.');
		}
		if (length === null) {
			return jsonError(400, 'bad_content_length', 'The Content-Length header is not a valid byte count.');
		}
		if (length > MAX_BODY_BYTES) {
			return jsonError(
				413,
				'payload_too_large',
				`This push is ${length} bytes; the relay accepts at most ${MAX_BODY_BYTES} bytes (95 MB) per request.`,
				{ limit: MAX_BODY_BYTES }
			);
		}
		init.body = fixedLengthBody(request.body, length);
	}

	/** @type {Response} */
	let upstream;
	try {
		upstream = await fetch(target.url, init);
	} catch {
		return jsonError(502, 'upstream_unreachable', 'The relay could not reach the git host.');
	}

	if (upstream.status >= 300 && upstream.status < 400) {
		// Never follow: the Location was not checked against the allowlist and the
		// request carries the user's Authorization header.
		await upstream.body?.cancel();
		return jsonError(
			502,
			'repo_moved',
			'The git host redirected this repository; it may have been renamed or moved. Update the repository URL.',
			{ location: upstream.headers.get('Location') }
		);
	}

	// Only git protocol bytes, or a host's plain-text error, reach the app
	// origin. Anything else (an HTML page, a JSON API answer) is not a git
	// response and must not be served from the app's own origin.
	const type = mediaType(upstream.headers.get('Content-Type'));
	const ok = upstream.status >= 200 && upstream.status < 300;
	if (ok ? type !== target.responseType : type !== 'text/plain') {
		await upstream.body?.cancel();
		if (ok) {
			return jsonError(502, 'unexpected_upstream_response', 'The git host did not answer with git protocol data.');
		}
		return jsonError(upstream.status, 'upstream_error', `The git host answered with HTTP ${upstream.status}.`);
	}

	const responseHeaders = new Headers();
	for (const name of FORWARD_RESPONSE_HEADERS) {
		const value = upstream.headers.get(name);
		if (value !== null) responseHeaders.set(name, value);
	}
	return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

/**
 * @param {string | null} value a Content-Type header
 * @returns {string} its lowercased media type without parameters
 */
function mediaType(value) {
	return (value ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Copies only the allowlisted request headers, and gives git hosts a git
 * `User-Agent` when the client did not send one (browsers cannot).
 * @param {Headers} incoming
 * @returns {Headers}
 */
function forwardHeaders(incoming) {
	const headers = new Headers();
	for (const name of FORWARD_REQUEST_HEADERS) {
		const value = incoming.get(name);
		if (value !== null) headers.set(name, value);
	}
	if (!headers.get('user-agent')?.startsWith('git/')) headers.set('user-agent', DEFAULT_USER_AGENT);
	return headers;
}

/**
 * @param {string | null} value
 * @returns {number | null | undefined} undefined when absent, null when invalid
 */
function parseContentLength(value) {
	if (value === null) return undefined;
	if (!/^\d{1,15}$/.test(value.trim())) return null;
	return Number(value.trim());
}

/**
 * Streams the body upstream with its declared length, so the git host gets a
 * `Content-Length` instead of chunked encoding, and a body longer or shorter
 * than declared fails the upstream request instead of passing the size cap.
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {number} length
 * @returns {ReadableStream<Uint8Array> | null}
 */
function fixedLengthBody(body, length) {
	if (body === null || length === 0) return null;
	const { readable, writable } = new FixedLengthStream(length);
	// A broken pipe surfaces as a failed upstream fetch, which is handled there.
	body.pipeTo(writable).catch(() => {});
	return readable;
}
