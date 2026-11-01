/**
 * The parts of an authorization-code sign-in both providers share: PKCE, the
 * `state` check across the redirect, and calling a token endpoint.
 */

import { AuthError, AuthErrorCode } from './errors.js';

/** A sign-in left unfinished for this long no longer counts. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** How long any account request may take. */
export const REQUEST_TIMEOUT_MS = 30_000;

const PENDING_PREFIX = 'gitnote.oauth.pending.';

/**
 * What a token endpoint gave us, in the app's own shape.
 * @typedef {object} TokenSet
 * @property {string} accessToken
 * @property {string} [refreshToken] absent on a token that does not expire
 * @property {number} [expiresAt] epoch ms; absent on a token that does not expire
 * @property {number} [refreshExpiresAt] epoch ms; absent when the provider does not say
 */

/**
 * What must survive the redirect to the provider and back. It holds no token,
 * and the verifier is useless without the code the provider sends to this device.
 * @typedef {object} PendingSignIn
 * @property {import('../git/limits.js').ProviderId} provider
 * @property {string} verifier
 * @property {string} redirectUri
 * @property {number} createdAt epoch ms
 */

/**
 * @param {Uint8Array} bytes
 * @returns {string} base64url without padding
 */
function base64Url(bytes) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

/**
 * @returns {string} 256 random bits as text: a PKCE verifier or a `state`
 */
export function randomToken() {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * @param {string} verifier
 * @returns {Promise<string>} the S256 PKCE challenge
 */
export async function pkceChallenge(verifier) {
	return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/**
 * Records a sign-in about to leave for the provider. One entry per `state`, so
 * sign-ins from two tabs cannot overwrite each other. It lives in localStorage,
 * not sessionStorage, so it survives Android killing the app behind the browser
 * tab. Entries from abandoned sign-ins are cleared here.
 * @param {Storage} storage
 * @param {string} state
 * @param {PendingSignIn} pending
 * @param {number} now
 * @returns {void}
 */
export function savePending(storage, state, pending, now) {
	for (let index = storage.length - 1; index >= 0; index -= 1) {
		const key = storage.key(index);
		if (key?.startsWith(PENDING_PREFIX) && parsePending(storage.getItem(key), now) === null) storage.removeItem(key);
	}
	storage.setItem(PENDING_PREFIX + state, JSON.stringify(pending));
}

/**
 * Takes the sign-in a redirect belongs to. An entry works once, whatever happens
 * next, so a replayed redirect finds nothing.
 * @param {Storage} storage
 * @param {string} state
 * @param {number} now
 * @returns {PendingSignIn | null} null when this device did not start it, or it is too old
 */
export function takePending(storage, state, now) {
	const key = PENDING_PREFIX + state;
	const pending = parsePending(storage.getItem(key), now);
	storage.removeItem(key);
	return pending;
}

/**
 * @param {string | null} text
 * @param {number} now
 * @returns {PendingSignIn | null}
 */
function parsePending(text, now) {
	if (text === null) return null;
	/** @type {Partial<PendingSignIn> | null} */
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		typeof value?.provider !== 'string' ||
		typeof value.verifier !== 'string' ||
		typeof value.redirectUri !== 'string' ||
		typeof value.createdAt !== 'number' ||
		now - value.createdAt > PENDING_TTL_MS ||
		now < value.createdAt
	) {
		return null;
	}
	return /** @type {PendingSignIn} */ (value);
}

/**
 * @param {unknown} value
 * @returns {value is string} text that can travel in an Authorization header
 */
export function isTokenText(value) {
	return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isSeconds(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * @param {unknown} data a token endpoint's JSON
 * @param {number} now
 * @returns {TokenSet}
 */
export function parseTokenResponse(data, now) {
	const body = /** @type {Record<string, unknown>} */ (typeof data === 'object' && data !== null ? data : {});
	if (!isTokenText(body.access_token)) {
		throw new AuthError(AuthErrorCode.UNAVAILABLE, 'The git host answered the sign-in without a usable token.');
	}
	/** @type {TokenSet} */
	const tokens = { accessToken: body.access_token };
	if (isTokenText(body.refresh_token)) tokens.refreshToken = body.refresh_token;
	if (isSeconds(body.expires_in)) tokens.expiresAt = now + body.expires_in * 1000;
	if (isSeconds(body.refresh_token_expires_in)) tokens.refreshExpiresAt = now + body.refresh_token_expires_in * 1000;
	return tokens;
}

/**
 * Posts to a token endpoint and sorts the failures. A 4xx means the grant was
 * refused, which is final; anything else may pass, so the caller keeps what it
 * has. `credentials: 'omit'` keeps any provider cookie out of the exchange.
 * @param {object} options
 * @param {typeof fetch} options.fetch
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {string} options.body
 * @param {string} options.hostLabel names the other side in messages
 * @param {(detail: string | null) => AuthError} options.rejected builds the error for a refused grant
 * @returns {Promise<unknown>} the JSON body of a 2xx answer
 */
export async function postTokenRequest({ fetch: fetchImpl, url, headers, body, hostLabel, rejected }) {
	/** @type {Response} */
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'POST',
			headers,
			body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			redirect: 'error',
			credentials: 'omit'
		});
	} catch (cause) {
		throw new AuthError(AuthErrorCode.UNAVAILABLE, `Could not reach ${hostLabel}. Check the connection and try again.`, { cause });
	}
	/** @type {unknown} */
	const data = await response.json().catch(() => null);
	if (response.ok) return data;
	if (response.status === 429 || response.status >= 500) {
		throw new AuthError(AuthErrorCode.UNAVAILABLE, `${hostLabel} is not available right now (status ${response.status}). Try again later.`);
	}
	const fields = /** @type {{ message?: unknown, error_description?: unknown }} */ (typeof data === 'object' && data !== null ? data : {});
	const detail = fields.message ?? fields.error_description;
	throw rejected(typeof detail === 'string' ? detail : null);
}
