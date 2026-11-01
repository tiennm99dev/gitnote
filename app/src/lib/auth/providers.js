/**
 * The git providers gitnote can sign in to. What differs between them as plain
 * data lives here; each provider's sign-in and API calls live in its own module.
 */

import { isProviderId } from '../git/limits.js';

/** @typedef {import('../git/limits.js').ProviderId} ProviderId */

/**
 * @typedef {object} Provider
 * @property {ProviderId} id also the key of the size limits in `git/limits.js`
 * @property {string} label
 * @property {string} gitHost the host of its clone URLs
 * @property {string} apiBase the REST API root, without a trailing slash
 * @property {Readonly<Record<string, string>>} apiHeaders sent on every REST call
 * @property {string} gitUsername the basic-auth username that goes with a token
 * @property {string} tokenHint which pasted token works, and its permissions
 * @property {string} tokenUrl where to create that token
 */

/** @type {Readonly<Record<ProviderId, Readonly<Provider>>>} */
export const PROVIDERS = Object.freeze({
	github: Object.freeze({
		id: /** @type {const} */ ('github'),
		label: 'GitHub',
		gitHost: 'github.com',
		apiBase: 'https://api.github.com',
		apiHeaders: Object.freeze({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }),
		gitUsername: 'x-access-token',
		tokenHint: 'A fine-grained personal access token with Contents read and write on the repos you want.',
		tokenUrl: 'https://github.com/settings/personal-access-tokens/new'
	}),
	gitlab: Object.freeze({
		id: /** @type {const} */ ('gitlab'),
		label: 'GitLab',
		gitHost: 'gitlab.com',
		apiBase: 'https://gitlab.com/api/v4',
		apiHeaders: Object.freeze({ Accept: 'application/json' }),
		gitUsername: 'oauth2',
		tokenHint: 'A personal access token with the write_repository and read_api scopes.',
		tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens'
	})
});

/** @type {readonly ProviderId[]} */
export const PROVIDER_IDS = Object.freeze(/** @type {ProviderId[]} */ (Object.keys(PROVIDERS)));

/** The in-app path both providers redirect to on the web. */
export const WEB_CALLBACK_PATH = '/auth/callback';

/**
 * @param {string} id
 * @returns {Readonly<Provider>}
 */
export function getProvider(id) {
	if (!isProviderId(id)) throw new TypeError(`Unknown git provider: ${id}`);
	return PROVIDERS[id];
}

/**
 * @param {ProviderId} id
 * @param {string} url a git remote URL
 * @returns {boolean} whether a token for this provider may be sent for this URL
 */
export function isProviderGitUrl(id, url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' && parsed.host.toLowerCase() === getProvider(id).gitHost;
	} catch {
		return false;
	}
}
