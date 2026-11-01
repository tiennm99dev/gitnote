/**
 * GitHub sign-in through a GitHub App, and its REST calls. The code exchange and
 * refresh need the App's client secret and GitHub's token endpoint sends no CORS
 * headers, so both go through the relay. The REST API is CORS-enabled and is
 * called directly.
 */

import { branchNames, isRepoPath, optionalText, PER_PAGE, readPages } from './api-lists.js';
import { AuthError, AuthErrorCode } from './errors.js';
import { parseTokenResponse, postTokenRequest, refreshRejection } from './oauth.js';

/** @typedef {import('./session.js').ProviderAdapter} ProviderAdapter */
/** @typedef {import('./session.js').RemoteRepo} RemoteRepo */

/** A GitHub repo is exactly `owner/name`; the relay refuses anything else. */
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const RELAY_LABEL = 'The gitnote relay';

/**
 * @param {object} options
 * @param {string} options.clientId the App's client ID; blank turns sign-in off
 * @param {string} [options.appSlug] the App's URL name, for its install page
 * @param {string} [options.relayOrigin] defaults to the page's own origin
 * @param {typeof fetch} [options.fetch]
 * @returns {ProviderAdapter}
 */
export function createGithubAdapter({ clientId, appSlug = '', relayOrigin = globalThis.location?.origin, fetch: fetchImpl = (...args) => globalThis.fetch(...args) }) {
	/**
	 * @param {string} route
	 * @param {Record<string, string>} fields
	 * @param {number} now
	 * @param {(detail: string | null, code: string | null, status: number) => AuthError} rejected
	 * @returns {Promise<import('./oauth.js').TokenSet>}
	 */
	const callRelay = async (route, fields, now, rejected) =>
		parseTokenResponse(
			await postTokenRequest({
				fetch: fetchImpl,
				url: `${relayOrigin}/api/oauth/github/${route}`,
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify(fields),
				hostLabel: RELAY_LABEL,
				rejected
			}),
			now
		);

	return {
		signInAvailable: clientId !== '',

		authorizeUrl({ state, challenge, redirectUri }) {
			const url = new URL('https://github.com/login/oauth/authorize');
			url.search = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				state,
				code_challenge: challenge,
				code_challenge_method: 'S256'
			}).toString();
			return url.href;
		},

		exchangeCode: ({ code, verifier, redirectUri, now }) =>
			callRelay('token', { code, code_verifier: verifier, redirect_uri: redirectUri }, now, (detail) =>
				new AuthError(AuthErrorCode.SIGN_IN_FAILED, detail ?? 'GitHub refused the sign-in. Try again.')
			),

		refresh: ({ refreshToken, now }) =>
			callRelay('refresh', { refresh_token: refreshToken }, now, refreshRejection('GitHub', RELAY_LABEL)),

		async fetchUser(api) {
			const user = /** @type {{ login?: unknown, name?: unknown, email?: unknown }} */ (await api('/user'));
			if (typeof user?.login !== 'string') throw new AuthError(AuthErrorCode.UNAVAILABLE, 'GitHub answered with an unexpected account.');
			return { login: user.login, name: optionalText(user.name), email: optionalText(user.email) };
		},

		/*
		 * A GitHub App's token sees only the repos the App is installed on, listed
		 * per installation. A personal access token cannot call those endpoints; it
		 * lists what it can reach through /user/repos.
		 */
		async listRepos(api, kind) {
			if (kind === 'token') {
				const { items, truncated } = await readPages((page) => api(`/user/repos?per_page=${PER_PAGE}&sort=updated&page=${page}`));
				return { repos: toRepos(items), truncated };
			}
			const installUrl = appSlug ? `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new` : 'https://github.com/settings/installations';
			const { items: installations } = await readPages((page) =>
				api(`/user/installations?per_page=${PER_PAGE}&page=${page}`).then((data) => /** @type {{ installations?: unknown } | null} */ (data)?.installations)
			);
			/** @type {unknown[]} */
			const raw = [];
			let truncated = false;
			for (const installation of installations) {
				const id = /** @type {{ id?: unknown }} */ (installation)?.id;
				if (typeof id !== 'number') continue;
				const pages = await readPages((page) =>
					api(`/user/installations/${id}/repositories?per_page=${PER_PAGE}&page=${page}`).then((data) => /** @type {{ repositories?: unknown } | null} */ (data)?.repositories)
				);
				raw.push(...pages.items);
				truncated ||= pages.truncated;
			}
			return { repos: toRepos(raw), truncated, installUrl };
		},

		async listBranches(api, repo) {
			const { items } = await readPages((page) => api(`/repos/${repo.fullName}/branches?per_page=${PER_PAGE}&page=${page}`));
			return branchNames(items);
		}
	};
}

/**
 * Builds the app's repo records from API data, dropping what it cannot use. The
 * clone URL is built, not taken from the API, so a token only ever goes to the
 * provider's own host, and it ends in `.git` as the relay requires.
 * @param {unknown[]} raw
 * @returns {RemoteRepo[]}
 */
function toRepos(raw) {
	/** @type {Map<number, RemoteRepo>} */
	const repos = new Map();
	for (const item of raw) {
		const repo = /** @type {{ id?: unknown, full_name?: unknown, default_branch?: unknown, size?: unknown, private?: unknown }} */ (item);
		if (typeof repo?.id !== 'number' || !isRepoPath(repo.full_name, FULL_NAME)) continue;
		repos.set(repo.id, {
			provider: 'github',
			id: repo.id,
			fullName: repo.full_name,
			url: `https://github.com/${repo.full_name}.git`,
			defaultBranch: optionalText(repo.default_branch),
			// GitHub reports kibibytes.
			sizeBytes: typeof repo.size === 'number' ? repo.size * 1024 : null,
			isPrivate: repo.private === true,
			empty: false
		});
	}
	return [...repos.values()];
}
