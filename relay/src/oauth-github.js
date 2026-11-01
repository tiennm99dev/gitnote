import { Hono } from 'hono';
import { jsonError } from './json-error.js';

/** GitHub's token endpoint for both the code exchange and refresh. */
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Largest JSON request body the OAuth routes read. */
const MAX_JSON_BYTES = 8192;

const CODE = /^[A-Za-z0-9_-]{1,256}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const REFRESH_TOKEN = /^[A-Za-z0-9_.-]{1,1024}$/;
const MAX_REDIRECT_URI_LENGTH = 2048;

/** Token responses must never be cached anywhere. */
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/**
 * GitHub App user-token exchange and refresh. These calls need the App's
 * client secret, which the browser must never hold, and GitHub's token
 * endpoint sends no CORS headers. The Worker forwards each call and returns
 * GitHub's token JSON; it stores and logs nothing.
 * @type {Hono<import('./app-env.js').AppEnv>}
 */
export const oauthGithub = new Hono();

oauthGithub.post('/token', async (c) => {
	const input = await readJson(c);
	if (input instanceof Response) return input;
	const { code, code_verifier: codeVerifier, redirect_uri: redirectUri } = input;

	if (typeof code !== 'string' || !CODE.test(code)) {
		return jsonError(400, 'invalid_request', '`code` is missing or malformed.');
	}
	if (codeVerifier !== undefined && (typeof codeVerifier !== 'string' || !CODE_VERIFIER.test(codeVerifier))) {
		return jsonError(400, 'invalid_request', '`code_verifier` must be 43 to 128 PKCE characters.');
	}
	if (redirectUri !== undefined && !isUrl(redirectUri)) {
		return jsonError(400, 'invalid_request', '`redirect_uri` must be an absolute URL.');
	}

	/** @type {Record<string, string>} */
	const fields = { code };
	if (codeVerifier !== undefined) fields.code_verifier = codeVerifier;
	if (redirectUri !== undefined) fields.redirect_uri = /** @type {string} */ (redirectUri);
	return exchange(c, fields);
});

oauthGithub.post('/refresh', async (c) => {
	const input = await readJson(c);
	if (input instanceof Response) return input;
	const { refresh_token: refreshToken } = input;

	if (typeof refreshToken !== 'string' || !REFRESH_TOKEN.test(refreshToken)) {
		return jsonError(400, 'invalid_request', '`refresh_token` is missing or malformed.');
	}
	return exchange(c, { grant_type: 'refresh_token', refresh_token: refreshToken });
});

/**
 * Sends the fields plus the App credentials to GitHub and relays the result:
 * the token JSON on success, a 400 carrying GitHub's error code when GitHub
 * rejects the grant, a 502 when GitHub answers with anything unexpected.
 * @param {import('./app-env.js').AppContext} c
 * @param {Record<string, string>} fields
 * @returns {Promise<Response>}
 */
async function exchange(c, fields) {
	const clientId = c.env.GITHUB_CLIENT_ID;
	const clientSecret = c.env.GITHUB_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		return jsonError(503, 'oauth_not_configured', 'GitHub sign-in is not configured on this relay.');
	}

	/** @type {Response} */
	let upstream;
	try {
		upstream = await fetch(GITHUB_TOKEN_URL, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': 'gitnote-relay'
			},
			body: new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret }),
			redirect: 'manual'
		});
	} catch {
		return jsonError(502, 'upstream_unreachable', 'The relay could not reach GitHub.');
	}

	/** @type {unknown} */
	let data;
	try {
		data = await upstream.json();
	} catch {
		data = null;
	}
	if (!upstream.ok || !isObject(data)) {
		return jsonError(502, 'upstream_bad_response', `GitHub answered the token request with status ${upstream.status}.`);
	}
	if (typeof data.error === 'string') {
		const message = typeof data.error_description === 'string' ? data.error_description : 'GitHub rejected the request.';
		return jsonError(400, data.error, message, {}, NO_STORE);
	}
	if (typeof data.access_token !== 'string') {
		return jsonError(502, 'upstream_bad_response', 'GitHub returned no access token.');
	}
	return Response.json(data, { headers: NO_STORE });
}

/**
 * Reads a small JSON object body, or returns the error response to send.
 * @param {import('./app-env.js').AppContext} c
 * @returns {Promise<Record<string, unknown> | Response>}
 */
async function readJson(c) {
	const contentType = c.req.header('Content-Type') ?? '';
	if (!/^application\/json\s*(;|$)/i.test(contentType)) {
		return jsonError(415, 'unsupported_media_type', 'Send the request body as application/json.');
	}
	const declared = Number(c.req.header('Content-Length') ?? 0);
	if (declared > MAX_JSON_BYTES) {
		return jsonError(413, 'payload_too_large', `OAuth request bodies are limited to ${MAX_JSON_BYTES} bytes.`);
	}
	/** @type {string} */
	let text;
	try {
		text = await c.req.text();
	} catch {
		return jsonError(400, 'invalid_json', 'The request body could not be read.');
	}
	if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
		return jsonError(413, 'payload_too_large', `OAuth request bodies are limited to ${MAX_JSON_BYTES} bytes.`);
	}
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return jsonError(400, 'invalid_json', 'The request body is not valid JSON.');
	}
	if (!isObject(parsed)) return jsonError(400, 'invalid_json', 'The request body must be a JSON object.');
	return parsed;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isUrl(value) {
	if (typeof value !== 'string' || value.length > MAX_REDIRECT_URI_LENGTH) return false;
	return URL.canParse(value);
}
