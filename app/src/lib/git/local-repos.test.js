import { memfs } from 'memfs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_CREDENTIAL } from '../../../test/git-http-server.js';
import { memoryStorage } from '../../../test/auth-doubles.js';
import { createRemote, RELAY_PORT } from '../../../test/remote-repo.js';
import { createGitHttp } from './http.js';
import { describeLocalWork, forgetLocalRepo, listLocalRepos, saveLocalRepo } from './local-repos.js';
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

	it('says it does not know, rather than zero, when a copy cannot be read', async () => {
		const broken = () => {
			throw new Error('storage failed');
		};

		expect(await describeLocalWork([ENTRY], broken)).toEqual([{ repo: ENTRY, unpushed: null, drafts: null }]);
	});
});
