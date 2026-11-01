import { openRepoFs, repoIdForUrl, getStorageUsage } from '../../src/lib/git/fs.js';
import { createGitHttp } from '../../src/lib/git/http.js';
import { createRepo } from '../../src/lib/git/repo.js';

// A test page for the engine on the real browser stack: LightningFS on
// IndexedDB, Web Locks, and fetch through the relay on this page's origin. It
// is built for the browser tests only and never ships in the app.

/**
 * One long-lived repo object per page, as the app holds it, so its parsed-object
 * cache lives as long as the tab and must stay right when another tab writes.
 * @type {Map<string, import('../../src/lib/git/repo.js').Repo>}
 */
const repos = new Map();

/**
 * @param {string} url
 * @returns {import('../../src/lib/git/repo.js').Repo}
 */
function openRepo(url) {
	const id = repoIdForUrl(url);
	const existing = repos.get(id);
	if (existing) return existing;
	const repo = createRepo({
		id,
		fs: /** @type {import('../../src/lib/git/repo.js').FsClient} */ (/** @type {unknown} */ (openRepoFs(id))),
		http: createGitHttp(),
		provider: 'github',
		// The local git server's fixture credential, not a secret.
		getCredential: () => ({ username: 'x-access-token', password: 'fixture-token' })
	});
	repos.set(id, repo);
	return repo;
}

Object.assign(globalThis, {
	/**
	 * @param {string} url
	 * @param {string} operation a method of the repo
	 * @param {unknown[]} args
	 * @returns {Promise<unknown>}
	 */
	callRepo(url, operation, args) {
		const repo = /** @type {Record<string, (...args: unknown[]) => Promise<unknown>>} */ (/** @type {unknown} */ (openRepo(url)));
		return repo[operation](...args);
	},
	getStorageUsage: () => getStorageUsage(),
	/**
	 * @param {string} url
	 * @returns {Promise<boolean>}
	 */
	wipeRepo: async (url) => {
		const repo = openRepo(url);
		return repo.wipeIfUnchanged(await repo.countWork());
	}
});
