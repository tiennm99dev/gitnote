/**
 * Opens and removes the repositories on this device, joining the engine, browser
 * storage and the account that signs its requests.
 */

import { authSession } from '../auth/index.js';
import { relayOrigin } from '../platform/native.js';
import { createWebDraftStore } from '../stores/drafts.js';
import { openRepoFs } from './fs.js';
import { createGitHttp } from './http.js';
import { describeLocalWork, forgetLocalRepo } from './local-repos.js';
import { createRepo } from './repo.js';

/** Unsaved editor buffers for every repository on this device. */
export const deviceDrafts = createWebDraftStore();

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
			http: createGitHttp({ relayOrigin: relayOrigin() }),
			provider,
			getCredential: authSession.gitCredentials(provider)
		});
		open.set(id, repo);
	}
	return repo;
}

/**
 * Counts what deleting each copy would lose, unsaved editor buffers included.
 * @param {import('./local-repos.js').LocalRepo[]} repos
 * @returns {Promise<import('./local-repos.js').LocalWork[]>}
 */
export function describeDeviceWork(repos) {
	return describeLocalWork(repos, openDeviceRepo, countUnsaved);
}

/**
 * @param {import('./local-repos.js').LocalRepo} repo
 * @returns {Promise<number>}
 */
async function countUnsaved(repo) {
	return (await deviceDrafts.listPaths(repo.id)).length;
}

/**
 * Deletes a repository's copy on this device, including unpushed commits and
 * unsaved editor buffers, if it still holds what the user was shown. The buffers
 * go too, because they hold note text and a later clone must not revive them.
 * @param {import('./local-repos.js').LocalWork} work what the user was shown
 * @returns {Promise<boolean>} false when the copy changed and nothing was deleted
 */
export async function deleteDeviceRepo({ repo, unpushed, drafts, unsaved }) {
	if (unsaved !== undefined && (await countUnsaved(repo).catch(() => null)) !== unsaved) return false;
	const deleted = await openDeviceRepo(repo).wipeIfUnchanged({ unpushed, drafts });
	if (!deleted) return false;
	try {
		await deviceDrafts.clear(repo.id);
	} finally {
		// The repo itself is gone; a failure above still surfaces to the caller.
		forgetLocalRepo(repo.id);
	}
	return true;
}
