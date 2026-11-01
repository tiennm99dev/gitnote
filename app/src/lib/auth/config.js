/**
 * Sign-in settings fixed at build time. They identify the registered apps and
 * are public: they ship in the bundle. The GitHub client secret never reaches
 * the app; it is a secret of the relay Worker.
 */

/**
 * @typedef {object} AuthConfig
 * @property {string} githubClientId the GitHub App's client ID
 * @property {string} githubAppSlug the App's URL name, for its install page
 * @property {string} gitlabClientId the gitlab.com application ID
 */

/**
 * @param {Record<string, unknown>} env
 * @returns {AuthConfig} a blank value leaves that provider's sign-in button off
 */
export function readAuthConfig(env) {
	/**
	 * @param {string} name
	 * @returns {string}
	 */
	const read = (name) => {
		const value = env[name];
		return typeof value === 'string' ? value.trim() : '';
	};
	return {
		githubClientId: read('VITE_GITHUB_CLIENT_ID'),
		githubAppSlug: read('VITE_GITHUB_APP_SLUG'),
		gitlabClientId: read('VITE_GITLAB_CLIENT_ID')
	};
}

export const authConfig = readAuthConfig(import.meta.env);
