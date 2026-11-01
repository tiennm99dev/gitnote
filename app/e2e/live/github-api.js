/**
 * @typedef {object} GitHubRepoApi
 * @property {(branch: string) => Promise<string>} resetBranch
 * @property {(path: string, branch: string) => Promise<string>} readText
 * @property {(path: string, branch: string, text: string, message: string) => Promise<void>} putText
 */

const API = 'https://api.github.com';

/**
 * The live test's own way to the test repo, which goes straight to GitHub. It sets the
 * repo up and witnesses what the app did, so it must not share the app's path.
 * @param {string} repo `<owner>/<repo>`
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {GitHubRepoApi}
 */
export function createGitHubApi(repo, token, fetchImpl = fetch) {
	if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repo)) throw new Error('The test repo must look like owner/repo.');

	/**
	 * @param {string} method
	 * @param {string} path after the repo's API root
	 * @param {unknown} [body]
	 * @returns {Promise<Response>}
	 */
	const send = (method, path, body) =>
		fetchImpl(`${API}/repos/${repo}${path}`, {
			method,
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${token}`,
				'x-github-api-version': '2022-11-28',
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});

	/**
	 * @param {string} what
	 * @param {Response} response
	 * @returns {Promise<{ default_branch: string, object: { sha: string }, content: string }>}
	 *   the JSON answer, of which each caller reads only the field its endpoint has
	 */
	async function json(what, response) {
		if (!response.ok) throw new Error(`GitHub refused to ${what}: HTTP ${response.status}.`);
		return response.json();
	}

	return {
		/**
		 * Points a branch at the tip of the default branch, creating it if needed.
		 * @param {string} branch
		 * @returns {Promise<string>} the commit it now points at
		 */
		async resetBranch(branch) {
			const { default_branch: base } = await json('read the repo', await send('GET', ''));
			if (branch === base) throw new Error('The test branch must not be the default branch.');
			const { object } = await json('read the default branch', await send('GET', `/git/ref/heads/${encodeURIComponent(base)}`));
			const updated = await send('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: object.sha, force: true });
			// GitHub answers 422 "Reference does not exist" on a branch that is not there yet.
			if (updated.status === 422) await json('create the test branch', await send('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: object.sha }));
			else await json('reset the test branch', updated);
			return object.sha;
		},

		/**
		 * @param {string} path
		 * @param {string} branch
		 * @returns {Promise<string>} the file's text on that branch
		 */
		async readText(path, branch) {
			const { content } = await json('read a file', await send('GET', `/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`));
			return Buffer.from(content, 'base64').toString('utf8');
		},

		/**
		 * Creates a file on a branch, as another device would.
		 * @param {string} path
		 * @param {string} branch
		 * @param {string} text
		 * @param {string} message
		 * @returns {Promise<void>}
		 */
		async putText(path, branch, text, message) {
			await json('write a file', await send('PUT', `/contents/${encodeURI(path)}`, { branch, message, content: Buffer.from(text).toString('base64') }));
		}
	};
}
