import { E2E_GIT_PORT, E2E_RELAY_PORT } from './git-engine-ports.js';

/**
 * The provider's REST API is answered here and its sign-in pages are stood in
 * for, because this suite must not touch github.com or gitlab.com. Git traffic
 * is real: the app's request for the provider's host is forwarded to the real
 * relay in front of a local `git http-backend`, and the app's code, build and
 * CSP are the production ones.
 */

export const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

/** Fixture values for local stand-ins. None of them is a secret. */
export const GOOD_TOKEN = 'e2e_fixture_token_abcdef';
export const BAD_TOKEN = 'e2e_refused_token_abcdef';
export const REFRESH_TOKEN = 'e2e_fixture_refresh_abcdef';

/** @typedef {'github' | 'gitlab'} ProviderId */

export const PROVIDERS = /** @type {const} */ ({
	github: { host: 'github.com', api: 'https://api.github.com', gitUsername: 'x-access-token', user: { login: 'octo', name: 'Octo', email: null } },
	gitlab: { host: 'gitlab.com', api: 'https://gitlab.com/api/v4', gitUsername: 'oauth2', user: { username: 'octo', name: 'Octo', email: null } }
});

/**
 * @param {string} token
 * @param {ProviderId} provider
 * @returns {string} the Authorization header git must send
 */
export function gitAuthorization(token, provider) {
	return `Basic ${Buffer.from(`${PROVIDERS[provider].gitUsername}:${token}`).toString('base64')}`;
}

/**
 * Forwards the app's git requests for a provider's host to the local server,
 * refusing anything without the right credential, as a private repo does.
 * @param {import('@playwright/test').Page} page
 * @param {ProviderId} provider
 * @param {string} token
 * @returns {Promise<{ authorized: () => number }>}
 */
export async function serveGit(page, provider, token) {
	const { host } = PROVIDERS[provider];
	let authorized = 0;
	await page.route(new RegExp(`/api/git/${host.replace('.', '\\.')}/`), async (route) => {
		const request = route.request();
		if ((await request.headerValue('authorization')) !== gitAuthorization(token, provider)) {
			await route.fulfill({ status: 401, headers: { 'www-authenticate': 'Basic realm="fixture"', 'content-type': 'text/plain' }, body: 'sign in' });
			return;
		}
		authorized += 1;
		const url = new URL(request.url());
		const path = url.pathname.replace(`/api/git/${host}/`, `/api/git/localhost:${E2E_GIT_PORT}/`);
		const headers = { ...request.headers() };
		// The test runner is the relay's client here, not the page's origin.
		for (const name of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) delete headers[name];
		const response = await route.fetch({ url: `http://127.0.0.1:${E2E_RELAY_PORT}${path}${url.search}`, headers });
		await route.fulfill({ response });
	});
	return { authorized: () => authorized };
}

/**
 * Stands in for the provider's REST API.
 * @param {import('@playwright/test').Page} page
 * @param {ProviderId} provider
 * @param {string} token the only bearer token it accepts
 * @param {Record<string, unknown>} answers JSON by path and query, after the API root
 * @returns {Promise<string[]>} the bearer headers it saw
 */
export async function serveApi(page, provider, token, answers) {
	const { api, user } = PROVIDERS[provider];
	/** @type {string[]} */
	const seen = [];
	await page.route(`${api}/**`, async (route) => {
		const request = route.request();
		const authorization = (await request.headerValue('authorization')) ?? '';
		seen.push(authorization);
		if (authorization !== `Bearer ${token}`) {
			await route.fulfill({ status: 401, headers: CORS, body: '{"message":"Bad credentials"}' });
			return;
		}
		const path = request.url().slice(api.length);
		const answer = path === '/user' ? user : answers[path];
		await route.fulfill(answer === undefined ? { status: 404, headers: CORS, body: '{"message":"Not Found"}' } : { status: 200, headers: CORS, body: JSON.stringify(answer) });
	});
	return seen;
}

/**
 * Collects what would mean the production build broke under its own CSP.
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
export function collectBreakage(page) {
	/** @type {string[]} */
	const problems = [];
	page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text());
	});
	return problems;
}
