/**
 * The isomorphic-git HTTP client. Browsers cannot call git hosts directly (no
 * CORS on smart-HTTP), so every request goes to the relay at
 * `<relay origin>/api/git/<host>/<repo path>.git/...`. The remote URL stored in
 * the repo stays the host's real URL.
 */

import { request as webRequest } from 'isomorphic-git/http/web';
import { networkError } from './errors.js';

/** @typedef {import('isomorphic-git').HttpClient} HttpClient */
/** @typedef {import('isomorphic-git').GitAuth} GitAuth */

/** How long a request may go without a response, or a response without a chunk. */
const STALL_TIMEOUT_MS = 60_000;

/**
 * fetch reports no upload progress, so a request's wait for its response also
 * allows for sending its body this slowly.
 */
const MIN_UPLOAD_BYTES_PER_SECOND = 16_000;

/**
 * @param {string} url a git host URL isomorphic-git wants to fetch
 * @param {string} relayOrigin e.g. `https://gitnote.miti99.dev`
 * @returns {string} the same request through the relay
 */
export function toRelayUrl(url, relayOrigin) {
	const target = new URL(url);
	if (target.protocol !== 'https:' && target.protocol !== 'http:') {
		throw new TypeError(`Git remotes must use http or https, not ${target.protocol}`);
	}
	if (target.username !== '' || target.password !== '') {
		// A credential in the URL would travel to the relay in the path.
		throw new TypeError('Git remote URLs must not carry credentials');
	}
	const origin = new URL(relayOrigin).origin;
	return `${origin}/api/git/${target.host}${target.pathname}${target.search}`;
}

/**
 * A connection that goes quiet ends in a `network` error rather than hanging.
 * @param {{ relayOrigin?: string, signal?: AbortSignal, stallTimeoutMs?: number }} [options]
 *   the relay origin defaults to the page's own origin; `signal` aborts every request
 * @returns {HttpClient}
 */
export function createGitHttp({ relayOrigin = globalThis.location?.origin, signal, stallTimeoutMs = STALL_TIMEOUT_MS } = {}) {
	if (!relayOrigin) throw new TypeError('createGitHttp needs a relay origin outside a browser page');
	const origin = relayOrigin;
	return {
		async request(request) {
			const url = toRelayUrl(request.url, origin);
			const callerSignal = request.signal ?? signal;
			const stall = new AbortController();
			/** @type {ReturnType<typeof setTimeout> | undefined} */
			let timer;
			/** @param {number} ms */
			const arm = (ms) => {
				clearTimeout(timer);
				timer = setTimeout(() => stall.abort(new Error('The connection stalled.')), ms);
			};
			const disarm = () => clearTimeout(timer);
			/**
			 * @param {unknown} error
			 * @returns {unknown}
			 */
			const translate = (error) => (stall.signal.aborted || (error instanceof TypeError && !callerSignal?.aborted) ? networkError(error) : error);
			/** @type {Uint8Array[] | undefined} */
			let body;
			let bodyBytes = 0;
			if (request.body) {
				body = [];
				for await (const chunk of request.body) {
					body.push(chunk);
					bodyBytes += chunk.byteLength;
				}
			}
			arm(stallTimeoutMs + (bodyBytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000);
			try {
				const response = await webRequest({
					...request,
					url,
					...(body ? { body: replay(body) } : {}),
					signal: callerSignal ? AbortSignal.any([callerSignal, stall.signal]) : stall.signal
				});
				return response.body ? { ...response, body: watchBody(response.body, translate, () => arm(stallTimeoutMs), disarm) } : response;
			} catch (error) {
				throw translate(error);
			} finally {
				disarm();
			}
		}
	};
}

/**
 * @param {Uint8Array[]} chunks
 * @yields {Uint8Array}
 */
async function* replay(chunks) {
	yield* chunks;
}

/**
 * A connection can also drop or go quiet while the response body is arriving.
 * The stall clock runs only while waiting for a chunk, never while the reader
 * is busy with the last one.
 * @param {AsyncIterableIterator<Uint8Array> | Iterable<Uint8Array>} body
 * @param {(error: unknown) => unknown} translate
 * @param {() => void} arm
 * @param {() => void} disarm
 * @yields {Uint8Array}
 */
async function* watchBody(body, translate, arm, disarm) {
	try {
		arm();
		for await (const chunk of body) {
			disarm();
			yield chunk;
			arm();
		}
	} catch (error) {
		throw translate(error);
	} finally {
		disarm();
	}
}

/**
 * @param {HttpClient} http
 * @param {AbortSignal | undefined} signal
 * @returns {HttpClient} the client with `signal` on every request
 */
export function withSignal(http, signal) {
	if (!signal) return http;
	return { request: (request) => http.request({ ...request, signal: request.signal ?? signal }) };
}

/**
 * @typedef {object} GitCredential
 * @property {string} username `x-access-token` on GitHub, `oauth2` on GitLab
 * @property {string} password the token
 */

/**
 * Supplies the credential for one request, or nothing when there is none.
 * `failed` is true after the host refused the previous credential, so the
 * account layer can refresh the token once.
 * @typedef {(request: { url: string, failed: boolean }) => Promise<GitCredential | null | undefined> | GitCredential | null | undefined} CredentialSource
 */

/**
 * Builds the isomorphic-git auth callbacks for one operation. After one
 * refused credential it gives up, so a source that keeps returning the same
 * token cannot loop forever.
 * @param {CredentialSource | undefined} getCredential
 * @returns {{ onAuth?: (url: string) => Promise<GitAuth | void>, onAuthFailure?: (url: string) => Promise<GitAuth | void> }}
 */
export function authCallbacks(getCredential) {
	if (!getCredential) return {};
	let retried = false;
	/**
	 * @param {string} url
	 * @param {boolean} failed
	 * @returns {Promise<GitAuth | void>}
	 */
	const ask = async (url, failed) => {
		const credential = await getCredential({ url, failed });
		if (!credential) return undefined;
		return { username: credential.username, password: credential.password };
	};
	return {
		onAuth: (url) => ask(url, false),
		onAuthFailure: async (url) => {
			if (retried) return undefined;
			retried = true;
			return ask(url, true);
		}
	};
}
