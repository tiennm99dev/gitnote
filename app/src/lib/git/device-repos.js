/**
 * Opens and removes the repositories on this device, joining the engine, browser
 * storage and the account that signs its requests.
 */

import { authSession } from '../auth/index.js';
import { openRepoFs, wipeRepoFs } from './fs.js';
import { createGitHttp } from './http.js';
import { forgetLocalRepo } from './local-repos.js';
import { createRepo } from './repo.js';

/**
 * One long-lived engine object per repo, so its parsed-object cache lasts as
 * long as the page.
 * @type {Map<string, import('./repo.js').Repo>}
 */
const open = new Map();

/**
 * @param {{ id: string, provider: import('./limits.js').ProviderId }} repo
 * @returns {import('./repo.js').Repo}
 */
export function openDeviceRepo({ id, provider }) {
	let repo = open.get(id);
	if (!repo) {
		repo = createRepo({
			id,
			fs: /** @type {import('./repo.js').FsClient} */ (/** @type {unknown} */ (openRepoFs(id))),
			http: createGitHttp(),
			provider,
			getCredential: authSession.gitCredentials(provider)
		});
		open.set(id, repo);
	}
	return repo;
}

/**
 * Deletes a repository's copy on this device, including unpushed commits.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteDeviceRepo(id) {
	await wipeRepoFs(id);
	forgetLocalRepo(id);
}
