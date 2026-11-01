/**
 * gitlab.com sign-in, and its REST calls. GitLab takes PKCE from a public client
 * with no secret and sends CORS headers on its token endpoint, so the whole flow
 * runs on the device and never touches the relay.
 */

import { branchNames, isRepoPath, optionalText, PER_PAGE, readPages } from './api-lists.js';
import { AuthError, AuthErrorCode } from './errors.js';
import { parseTokenResponse, postTokenRequest } from './oauth.js';

/** @typedef {import('./session.js').ProviderAdapter} ProviderAdapter */
/** @typedef {import('./session.js').RemoteRepo} RemoteRepo */

const ORIGIN = 'https://gitlab.com';
const SCOPES = 'read_user read_api write_repository';

/** GitLab groups nest: `group/subgroup/project`. */
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;

/**
 * @param {object} options
 * @param {string} options.clientId the application ID; blank turns sign-in off
 * @param {typeof fetch} [options.fetch]
 * @returns {ProviderAdapter}
 */
export function createGitlabAdapter({ clientId, fetch: fetchImpl = (...args) => globalThis.fetch(...args) }) {
	/**
	 * @param {Record<string, string>} fields
	 * @param {number} now
	 * @param {(detail: string | null) => AuthError} rejected
	 * @returns {Promise<import('./oauth.js').TokenSet>}
	 */
	const callTokenEndpoint = async (fields, now, rejected) =>
		parseTokenResponse(
			await postTokenRequest({
				fetch: fetchImpl,
				url: `${ORIGIN}/oauth/token`,
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
				body: new URLSearchParams({ ...fields, client_id: clientId }).toString(),
				hostLabel: 'GitLab',
				rejected
			}),
			now
		);

	return {
		signInAvailable: clientId !== '',

		authorizeUrl({ state, challenge, redirectUri }) {
			const url = new URL(`${ORIGIN}/oauth/authorize`);
			url.search = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				response_type: 'code',
				state,
				scope: SCOPES,
				code_challenge: challenge,
				code_challenge_method: 'S256'
			}).toString();
			return url.href;
		},

		exchangeCode: ({ code, verifier, redirectUri, now }) =>
			callTokenEndpoint({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, now, (detail) =>
				new AuthError(AuthErrorCode.SIGN_IN_FAILED, detail ?? 'GitLab refused the sign-in. Try again.')
			),

		refresh: ({ refreshToken, redirectUri, now }) =>
			callTokenEndpoint({ grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: redirectUri ?? '' }, now, () =>
				new AuthError(AuthErrorCode.SIGN_IN_REQUIRED, 'GitLab ended this sign-in. Sign in again; your notes on this device are safe.')
			),

		async fetchUser(api) {
			const user = /** @type {{ username?: unknown, name?: unknown, email?: unknown, commit_email?: unknown }} */ (await api('/user'));
			if (typeof user?.username !== 'string') throw new AuthError(AuthErrorCode.UNAVAILABLE, 'GitLab answered with an unexpected account.');
			return { login: user.username, name: optionalText(user.name), email: optionalText(user.commit_email) ?? optionalText(user.email) };
		},

		async listRepos(api) {
			const { items, truncated } = await readPages((page) =>
				api(`/projects?membership=true&simple=false&statistics=true&order_by=last_activity_at&per_page=${PER_PAGE}&page=${page}`)
			);
			return { repos: toRepos(items), truncated };
		},

		async listBranches(api, repo) {
			const { items } = await readPages((page) => api(`/projects/${repo.id}/repository/branches?per_page=${PER_PAGE}&page=${page}`));
			return branchNames(items);
		}
	};
}

/**
 * Builds the app's repo records from API data, dropping what it cannot use. The
 * clone URL is built, not taken from the API, so a token only ever goes to the
 * provider's own host, and it ends in `.git` as the relay requires. Project
 * statistics come back only for members with the Reporter role or above.
 * @param {unknown[]} raw
 * @returns {RemoteRepo[]}
 */
function toRepos(raw) {
	/** @type {RemoteRepo[]} */
	const repos = [];
	for (const item of raw) {
		const project = /** @type {{ id?: unknown, path_with_namespace?: unknown, default_branch?: unknown, statistics?: { repository_size?: unknown }, visibility?: unknown, empty_repo?: unknown }} */ (item);
		if (typeof project?.id !== 'number' || !isRepoPath(project.path_with_namespace, PROJECT_PATH)) continue;
		const size = project.statistics?.repository_size;
		repos.push({
			provider: 'gitlab',
			id: project.id,
			fullName: project.path_with_namespace,
			url: `${ORIGIN}/${project.path_with_namespace}.git`,
			defaultBranch: optionalText(project.default_branch),
			sizeBytes: typeof size === 'number' ? size : null,
			isPrivate: project.visibility !== 'public',
			empty: project.empty_repo === true
		});
	}
	return repos;
}
