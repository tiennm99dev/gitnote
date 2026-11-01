/**
 * The isomorphic-git HTTP client. Browsers cannot call git hosts directly (no
 * CORS on smart-HTTP), so every request goes to the relay at
 * `<relay origin>/api/git/<host>/<repo path>.git/...`. The remote URL stored in
 * the repo stays the host's real URL.
 */

import { request as webRequest } from 'isomorphic-git/http/web';

/** @typedef {import('isomorphic-git').HttpClient} HttpClient */
/** @typedef {import('isomorphic-git').GitAuth} GitAuth */

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
 * @param {{ relayOrigin?: string, signal?: AbortSignal }} [options] the relay
 *   origin defaults to the page's own origin; `signal` aborts every request
 * @returns {HttpClient}
 */
export function createGitHttp({ relayOrigin = globalThis.location?.origin, signal } = {}) {
	if (!relayOrigin) throw new TypeError('createGitHttp needs a relay origin outside a browser page');
	const origin = relayOrigin;
	return {
		request(request) {
			return webRequest({ ...request, url: toRelayUrl(request.url, origin), signal: request.signal ?? signal });
		}
	};
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
