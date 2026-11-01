import { describe, expect, it } from 'vitest';
import { readPages } from './api-lists.js';
import { readAuthConfig } from './config.js';
import { AuthErrorCode } from './errors.js';
import { createGithubAdapter } from './github.js';
import { createGitlabAdapter } from './gitlab.js';
import { getProvider, isProviderGitUrl, PROVIDER_IDS } from './providers.js';

/**
 * An API double keyed by the path and query each call asks for.
 * @param {Record<string, unknown>} answers
 * @returns {import('./session.js').ApiCall & { paths: string[] }}
 */
function apiDouble(answers) {
	/** @type {string[]} */
	const paths = [];
	const api = async (/** @type {string} */ path) => {
		paths.push(path);
		if (!Object.hasOwn(answers, path)) throw new Error(`unexpected call: ${path}`);
		return answers[path];
	};
	return Object.assign(api, { paths });
}

const githubRepo = {
	id: 1,
	full_name: 'miti/notes',
	default_branch: 'main',
	size: 2048,
	private: true,
	clone_url: 'https://evil.example.com/miti/notes.git'
};

describe('GitHub repositories', () => {
	const adapter = createGithubAdapter({ clientId: 'id', appSlug: 'gitnote', relayOrigin: 'https://relay.example.com' });

	it('are listed per installation for a GitHub App sign-in, once each', async () => {
		const api = apiDouble({
			'/user/installations?per_page=100&page=1': { installations: [{ id: 7 }, { id: 8 }] },
			'/user/installations/7/repositories?per_page=100&page=1': { repositories: [githubRepo] },
			'/user/installations/8/repositories?per_page=100&page=1': { repositories: [githubRepo, { ...githubRepo, id: 2, full_name: 'miti/e2e', private: false, default_branch: 'dev', size: 0 }] }
		});

		const { repos, truncated, installUrl } = await adapter.listRepos(api, 'oauth');

		expect(truncated).toBe(false);
		expect(installUrl).toBe('https://github.com/apps/gitnote/installations/new');
		expect(repos).toEqual([
			{ provider: 'github', id: 1, fullName: 'miti/notes', url: 'https://github.com/miti/notes.git', defaultBranch: 'main', sizeBytes: 2097152, isPrivate: true, empty: false },
			{ provider: 'github', id: 2, fullName: 'miti/e2e', url: 'https://github.com/miti/e2e.git', defaultBranch: 'dev', sizeBytes: 0, isPrivate: false, empty: false }
		]);
	});

	it('point at the install page when the App is on no repo yet', async () => {
		const api = apiDouble({ '/user/installations?per_page=100&page=1': { installations: [] } });

		const { repos, installUrl } = await adapter.listRepos(api, 'oauth');

		expect(repos).toEqual([]);
		expect(installUrl).toContain('/apps/gitnote/installations/new');
	});

	it('come from /user/repos for a pasted token, which cannot list installations', async () => {
		const api = apiDouble({ '/user/repos?per_page=100&sort=updated&page=1': [githubRepo] });

		const { repos, installUrl } = await adapter.listRepos(api, 'token');

		expect(repos.map((repo) => repo.url)).toEqual(['https://github.com/miti/notes.git']);
		expect(installUrl).toBeUndefined();
	});

	it.each(['a/b/c', '../x', 'a/b c', 'a'])('drop the unusable name %j', async (name) => {
		const api = apiDouble({ '/user/repos?per_page=100&sort=updated&page=1': [{ ...githubRepo, full_name: name }] });

		expect((await adapter.listRepos(api, 'token')).repos).toEqual([]);
	});

	it('list branches', async () => {
		const api = apiDouble({ '/repos/miti/notes/branches?per_page=100&page=1': [{ name: 'main' }, { name: 'dev' }, { nope: true }] });

		const branches = await adapter.listBranches(api, { provider: 'github', id: 1, fullName: 'miti/notes', url: '', defaultBranch: 'main', sizeBytes: 0, isPrivate: true, empty: false });

		expect(branches).toEqual(['main', 'dev']);
	});

	it('reads the account', async () => {
		expect(await adapter.fetchUser(apiDouble({ '/user': { login: 'octo', name: '', email: null } }))).toEqual({ login: 'octo', name: null, email: null });
		await expect(adapter.fetchUser(apiDouble({ '/user': {} }))).rejects.toMatchObject({ code: AuthErrorCode.UNAVAILABLE });
	});
});

describe('GitLab projects', () => {
	const adapter = createGitlabAdapter({ clientId: 'id' });
	const LIST = '/projects?membership=true&simple=false&statistics=true&order_by=last_activity_at&per_page=100&page=1';

	it('include nested groups, size and an empty project', async () => {
		const api = apiDouble({
			[LIST]: [
				{ id: 5, path_with_namespace: 'group/sub/notes', default_branch: 'main', statistics: { repository_size: 1234 }, visibility: 'private', empty_repo: false, http_url_to_repo: 'https://evil.example.com/x.git' },
				{ id: 6, path_with_namespace: 'group/blank', default_branch: null, visibility: 'public', empty_repo: true },
				{ id: 7, path_with_namespace: 'no-namespace' }
			]
		});

		const { repos } = await adapter.listRepos(api, 'oauth');

		expect(repos).toEqual([
			{ provider: 'gitlab', id: 5, fullName: 'group/sub/notes', url: 'https://gitlab.com/group/sub/notes.git', defaultBranch: 'main', sizeBytes: 1234, isPrivate: true, empty: false },
			{ provider: 'gitlab', id: 6, fullName: 'group/blank', url: 'https://gitlab.com/group/blank.git', defaultBranch: null, sizeBytes: null, isPrivate: false, empty: true }
		]);
	});

	it('list branches by project id', async () => {
		const api = apiDouble({ '/projects/5/repository/branches?per_page=100&page=1': [{ name: 'main' }] });

		expect(await adapter.listBranches(api, { provider: 'gitlab', id: 5, fullName: 'group/sub/notes', url: '', defaultBranch: 'main', sizeBytes: null, isPrivate: true, empty: false })).toEqual(['main']);
	});

	it('prefers the commit email', async () => {
		const api = apiDouble({ '/user': { username: 'tan', name: 'Tan', email: 'a@example.com', commit_email: 'b@example.com' } });

		expect((await adapter.fetchUser(api)).email).toBe('b@example.com');
	});
});

describe('readPages', () => {
	it('reads until a short page', async () => {
		const pages = [Array.from({ length: 100 }, (_, index) => index), [100]];

		const { items, truncated } = await readPages(async (page) => pages[page - 1]);

		expect(items).toHaveLength(101);
		expect(truncated).toBe(false);
	});

	it('stops and says so when the list goes on', async () => {
		let reads = 0;
		const { items, truncated } = await readPages(async () => {
			reads += 1;
			return Array.from({ length: 100 });
		});

		expect(reads).toBe(10);
		expect(items).toHaveLength(1000);
		expect(truncated).toBe(true);
	});

	it('refuses an answer that is not a list', async () => {
		await expect(readPages(async () => ({ message: 'nope' }))).rejects.toMatchObject({ code: AuthErrorCode.UNAVAILABLE });
	});
});

describe('providers', () => {
	it('have the settings git and the limits table need', () => {
		expect(PROVIDER_IDS).toEqual(['github', 'gitlab']);
		expect(getProvider('github').gitUsername).toBe('x-access-token');
		expect(getProvider('gitlab').gitUsername).toBe('oauth2');
		expect(() => getProvider('custom')).toThrow(TypeError);
	});

	it('match git URLs on the exact https host', () => {
		expect(isProviderGitUrl('github', 'https://GitHub.com/o/r.git')).toBe(true);
		expect(isProviderGitUrl('github', 'https://github.com:444/o/r.git')).toBe(false);
		expect(isProviderGitUrl('gitlab', 'https://github.com/o/r.git')).toBe(false);
	});
});

describe('build-time config', () => {
	it('reads and trims the client IDs', () => {
		expect(readAuthConfig({ VITE_GITHUB_CLIENT_ID: ' Iv1.abc ', VITE_GITHUB_APP_SLUG: 'gitnote', VITE_GITLAB_CLIENT_ID: 'def' })).toEqual({ githubClientId: 'Iv1.abc', githubAppSlug: 'gitnote', gitlabClientId: 'def' });
	});

	it('leaves sign-in off when they are missing', () => {
		expect(readAuthConfig({})).toEqual({ githubClientId: '', githubAppSlug: '', gitlabClientId: '' });
		expect(createGithubAdapter({ clientId: readAuthConfig({}).githubClientId }).signInAvailable).toBe(false);
		expect(createGitlabAdapter({ clientId: 'x' }).signInAvailable).toBe(true);
	});
});
