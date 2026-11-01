import { memfs } from 'memfs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_CREDENTIAL } from '../../../test/git-http-server.js';
import { memoryStorage } from '../../../test/auth-doubles.js';
import { createRemote, RELAY_PORT } from '../../../test/remote-repo.js';
import { createGitHttp } from './http.js';
import { describeLocalWork, describeWorkCounts, forgetLocalRepo, isSameWork, listLocalRepos, removeLocalCopies, saveLocalRepo, settleFailedClone } from './local-repos.js';
import { createRepo } from './repo.js';

/** @type {import('./local-repos.js').LocalRepo} */
const ENTRY = { id: 'github.com/o/b', url: 'https://github.com/o/b.git', provider: 'github', fullName: 'o/b', branch: 'main', ready: true };
const AUTHOR = { name: 'Local Author', email: 'local@example.com' };

describe('the list of local repos', () => {
	it('keeps entries apart and sorted', () => {
		const storage = memoryStorage();
		saveLocalRepo(ENTRY, storage);
		saveLocalRepo({ ...ENTRY, id: 'github.com/o/a', fullName: 'o/a' }, storage);
		storage.setItem('unrelated', 'x');

		expect(listLocalRepos(storage).map((repo) => repo.fullName)).toEqual(['o/a', 'o/b']);

		forgetLocalRepo('github.com/o/a', storage);
		expect(listLocalRepos(storage)).toEqual([ENTRY]);
	});

	it('skips damaged entries', () => {
		const storage = memoryStorage();
		storage.setItem('gitnote.repo.x', '{bad');
		storage.setItem('gitnote.repo.y', JSON.stringify({ ...ENTRY, provider: 'custom' }));

		expect(listLocalRepos(storage)).toEqual([]);
	});
});

describe('removeLocalCopies', () => {
	it('tries every copy and returns the ones still there', async () => {
		const shown = ['a', 'b', 'c', 'd'].map((id) => ({ repo: { ...ENTRY, id }, unpushed: 0, drafts: 0 }));
		/** @type {string[]} */
		const tried = [];

		const { failed, changed } = await removeLocalCopies(shown, async ({ repo }) => {
			tried.push(repo.id);
			if (repo.id === 'a') throw new Error('storage refused');
			return repo.id !== 'b';
		});

		expect(tried).toEqual(['a', 'b', 'c', 'd']);
		expect(failed.map((repo) => repo.id)).toEqual(['a']);
		expect(changed.map((repo) => repo.id)).toEqual(['b']);
	});

	it('spares a copy committed to while an earlier copy was being deleted', async () => {
		const first = await createRemote({ 'README.md': 'seed\n' });
		const second = await createRemote({ 'README.md': 'seed\n' });
		/** @type {Map<string, import('./repo.js').Repo>} */
		const engines = new Map();
		for (const remote of [first, second]) {
			const repo = createRepo({
				id: remote.id,
				fs: /** @type {import('./repo.js').FsClient} */ (/** @type {unknown} */ (memfs().fs)),
				http: createGitHttp({ relayOrigin: `http://127.0.0.1:${RELAY_PORT}` }),
				provider: 'github',
				getCredential: () => FIXTURE_CREDENTIAL
			});
			await repo.clone({ url: remote.url });
			engines.set(remote.id, repo);
		}
		const firstEngine = /** @type {import('./repo.js').Repo} */ (engines.get(first.id));
		const secondEngine = /** @type {import('./repo.js').Repo} */ (engines.get(second.id));
		const shown = await describeLocalWork(
			[first, second].map((remote) => ({ ...ENTRY, id: remote.id })),
			(repo) => /** @type {import('./repo.js').Repo} */ (engines.get(repo.id))
		);

		const { changed } = await removeLocalCopies(shown, async ({ repo, unpushed, drafts }) => {
			const engine = /** @type {import('./repo.js').Repo} */ (engines.get(repo.id));
			const deleted = await engine.wipeIfUnchanged({ unpushed, drafts });
			// Another tab commits to the other copy just after this one is gone.
			if (engine === firstEngine) {
				await secondEngine.writeFile('late.md', 'late\n');
				await secondEngine.commit({ paths: ['late.md'], message: 'late', author: AUTHOR });
			}
			return deleted;
		});

		expect(changed.map((repo) => repo.id)).toEqual([second.id]);
		expect(await firstEngine.isCloned()).toBe(false);
		expect(await secondEngine.countWork()).toEqual({ unpushed: 1, drafts: 0 });
	});
});

describe('settleFailedClone', () => {
	const ATTEMPT = { ...ENTRY, ready: false };
	const failedCheck = async () => {
		throw new Error('storage failed');
	};

	it('forgets its own entry when no copy is there', async () => {
		const storage = memoryStorage();
		saveLocalRepo(ATTEMPT, storage);

		await settleFailedClone({ entry: ATTEMPT, previous: undefined, isCloned: async () => false, storage });

		expect(listLocalRepos(storage)).toEqual([]);
	});

	it('keeps its own entry when the clone finished but could not be marked ready', async () => {
		const storage = memoryStorage();
		saveLocalRepo(ATTEMPT, storage);

		await settleFailedClone({ entry: ATTEMPT, previous: undefined, isCloned: async () => true, storage });

		expect(listLocalRepos(storage)).toEqual([ATTEMPT]);
	});

	it('keeps its own entry when it cannot tell whether a copy is there', async () => {
		const storage = memoryStorage();
		saveLocalRepo(ATTEMPT, storage);

		await settleFailedClone({ entry: ATTEMPT, previous: undefined, isCloned: failedCheck, storage });

		expect(listLocalRepos(storage)).toEqual([ATTEMPT]);
	});

	it('restores the record of a copy another tab already made', async () => {
		const storage = memoryStorage();
		saveLocalRepo({ ...ATTEMPT, branch: 'asked-for' }, storage);

		await settleFailedClone({ entry: { ...ATTEMPT, branch: 'asked-for' }, previous: ENTRY, isCloned: async () => false, storage });

		expect(listLocalRepos(storage)).toEqual([ENTRY]);
	});

	it('leaves the new entry in place when the browser refuses the restore', async () => {
		const storage = memoryStorage();
		saveLocalRepo(ATTEMPT, storage);
		storage.setItem = () => {
			throw new DOMException('quota', 'QuotaExceededError');
		};

		await settleFailedClone({ entry: ATTEMPT, previous: ENTRY, isCloned: async () => false, storage });

		expect(listLocalRepos(storage)).toEqual([ATTEMPT]);
	});
});

describe('isSameWork', () => {
	it('notices a new copy and a changed count', () => {
		const shown = [{ repo: ENTRY, unpushed: 0, drafts: 0 }];

		expect(isSameWork(shown, [{ repo: { ...ENTRY }, unpushed: 0, drafts: 0 }])).toBe(true);
		expect(isSameWork(shown, [{ repo: ENTRY, unpushed: 1, drafts: 0 }])).toBe(false);
		expect(isSameWork(shown, [...shown, { repo: { ...ENTRY, id: 'x' }, unpushed: 0, drafts: 0 }])).toBe(false);
	});
});

describe('describeWorkCounts', () => {
	it('never understates a copy it could not read', () => {
		expect(describeWorkCounts({ unpushed: null, drafts: null })).toContain('may hold unpushed work');
		expect(describeWorkCounts({ unpushed: 1, drafts: 2 })).toBe('1 unpushed commit, 2 uncommitted files');
		expect(describeWorkCounts({ unpushed: 1, drafts: 2, unsaved: 0 })).toBe('1 unpushed commit, 2 uncommitted files');
		expect(describeWorkCounts({ unpushed: 0, drafts: 0, unsaved: 1 })).toBe('0 unpushed commits, 0 uncommitted files, 1 unsaved note');
		expect(describeWorkCounts({ unpushed: 0, drafts: 0, unsaved: null })).toContain('may hold unpushed work');
	});
});

describe('describeLocalWork', () => {
	/**
	 * @param {import('../../../test/remote-repo.js').Remote} remote
	 * @returns {import('./repo.js').Repo}
	 */
	const openEngine = (remote) =>
		createRepo({
			id: remote.id,
			fs: /** @type {import('./repo.js').FsClient} */ (/** @type {unknown} */ (memfs().fs)),
			http: createGitHttp({ relayOrigin: `http://127.0.0.1:${RELAY_PORT}` }),
			provider: 'github',
			getCredential: () => FIXTURE_CREDENTIAL
		});

	it('counts unpushed commits and uncommitted files in a real clone', async () => {
		const remote = await createRemote({ 'README.md': 'seed\n' });
		const repo = openEngine(remote);
		await repo.clone({ url: remote.url });
		await repo.writeFile('one.md', 'one\n');
		await repo.commit({ paths: ['one.md'], message: 'one', author: AUTHOR });
		await repo.writeFile('two.md', 'two\n');
		await repo.commit({ paths: ['two.md'], message: 'two', author: AUTHOR });
		await repo.writeFile('draft.md', 'draft\n');

		expect(await describeLocalWork([ENTRY], () => repo)).toEqual([{ repo: ENTRY, unpushed: 2, drafts: 1 }]);
	});

	it('finds nothing at risk in a clone that never finished', async () => {
		const repo = openEngine(await createRemote({ 'README.md': 'seed\n' }));

		expect(await describeLocalWork([ENTRY], () => repo)).toEqual([{ repo: ENTRY, unpushed: 0, drafts: 0 }]);
	});

	it('adds the editor buffers kept outside the repo, or says it could not count them', async () => {
		const repo = openEngine(await createRemote({ 'README.md': 'seed\n' }));

		expect(await describeLocalWork([ENTRY], () => repo, async () => 2)).toEqual([{ repo: ENTRY, unpushed: 0, drafts: 0, unsaved: 2 }]);
		expect(await describeLocalWork([ENTRY], () => repo, () => Promise.reject(new Error('blocked')))).toEqual([{ repo: ENTRY, unpushed: 0, drafts: 0, unsaved: null }]);
	});

	it('says it does not know, rather than zero, when a copy cannot be read', async () => {
		const broken = () => {
			throw new Error('storage failed');
		};

		expect(await describeLocalWork([ENTRY], broken)).toEqual([{ repo: ENTRY, unpushed: null, drafts: null }]);
	});
});
