/**
 * Opens and removes the repositories on this device, joining the engine, browser
 * storage and the account that signs its requests.
 */

import { authSession } from '../auth/index.js';
import { openRepoFs } from './fs.js';
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
 * Deletes a repository's copy on this device, including unpushed commits, if it
 * still holds what the user was shown.
 * @param {import('./local-repos.js').LocalWork} work what the user was shown
 * @returns {Promise<boolean>} false when the copy changed and nothing was deleted
 */
export async function deleteDeviceRepo({ repo, unpushed, drafts }) {
	const deleted = await openDeviceRepo(repo).wipeIfUnchanged({ unpushed, drafts });
	if (deleted) forgetLocalRepo(repo.id);
	return deleted;
}
