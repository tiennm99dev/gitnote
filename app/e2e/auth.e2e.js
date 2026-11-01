/* global indexedDB, window, IDBObjectStore */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createRemote, pushFromElsewhere, runGit } from '../test/remote-repo.js';
import { E2E_GIT_PORT, E2E_GIT_ROOT } from './git-engine-ports.js';
import { BAD_TOKEN, collectBreakage, CORS, GOOD_TOKEN, PROVIDERS, REFRESH_TOKEN, serveApi, serveGit } from './provider-fixtures.js';

/** @typedef {import('./provider-fixtures.js').ProviderId} ProviderId */

/**
 * Everything this origin keeps, as text: every IndexedDB database with its bytes
 * decoded, localStorage and sessionStorage.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
function dumpBrowserStorage(page) {
	return page.evaluate(async () => {
		/**
		 * @param {unknown} value
		 * @returns {string}
		 */
		const flatten = (value) => {
			if (value instanceof ArrayBuffer) return String.fromCharCode(...new Uint8Array(value));
			if (ArrayBuffer.isView(value)) return String.fromCharCode(...new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
			if (value instanceof CryptoKey) return `[key extractable=${value.extractable}]`;
			if (Array.isArray(value)) return value.map(flatten).join('|');
			if (typeof value === 'object' && value !== null) return Object.entries(value).map(([key, item]) => `${key}=${flatten(item)}`).join('|');
			return String(value);
		};
		/** @type {string[]} */
		const parts = [JSON.stringify(localStorage), JSON.stringify(sessionStorage)];
		for (const { name } of await indexedDB.databases()) {
			if (!name) continue;
			/** @type {IDBDatabase} */
			const db = await new Promise((resolve, reject) => {
				const open = indexedDB.open(name);
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			for (const storeName of db.objectStoreNames) {
				const values = await new Promise((resolve, reject) => {
					const all = db.transaction(storeName).objectStore(storeName).getAll();
					all.onsuccess = () => resolve(all.result);
					all.onerror = () => reject(all.error);
				});
				parts.push(`${name}/${storeName}: ${flatten(values)}`);
			}
			db.close();
		}
		return parts.join('\n');
	});
}

/**
 * A repo with `main` and an older branch `drafts` that has one file fewer.
 * @returns {Promise<{ id: number, fullName: string, remote: import('../test/remote-repo.js').Remote }>}
 */
async function repoWithBranches() {
	const remote = await createRemote({ 'README.md': 'seed\n', 'notes/a.md': '# a\n' }, { root: E2E_GIT_ROOT, port: E2E_GIT_PORT });
	await runGit(['branch', 'drafts', 'main'], remote.bare);
	await pushFromElsewhere(remote, { 'notes/b.md': '# b\n' }, 'main moves on');
	return { id: 41, fullName: new URL(remote.url).pathname.slice(1).replace(/\.git$/, ''), remote };
}

test.describe.configure({ timeout: 60_000 });

test('a pasted GitHub token connects, picks a branch, clones through the relay, and stays encrypted', async ({ page }) => {
	const problems = collectBreakage(page);
	const { fullName } = await repoWithBranches();
	const other = { id: 42, full_name: 'octo/other-repo', default_branch: 'main', size: 900_000, private: false };
	const seen = await serveApi(page, 'github', GOOD_TOKEN, {
		'/user/repos?per_page=100&sort=updated&page=1': [{ id: 41, full_name: fullName, default_branch: 'main', size: 12, private: true }, other],
		[`/repos/${fullName}/branches?per_page=100&page=1`]: [{ name: 'main' }, { name: 'drafts' }]
	});
	const git = await serveGit(page, 'github', GOOD_TOKEN);

	await page.goto('/connect');
	const github = page.getByTestId('account-github');

	// A refused token leaves nothing behind.
	await github.getByLabel('Or paste a token').fill(BAD_TOKEN);
	await github.getByRole('button', { name: 'Check and save' }).click();
	await expect(page.getByTestId('account-github-error')).toContainText('did not accept this token');
	expect(await dumpBrowserStorage(page)).not.toContain(BAD_TOKEN);

	await github.getByLabel('Or paste a token').fill(GOOD_TOKEN);
	await github.getByRole('button', { name: 'Check and save' }).click();
	await expect(page.getByTestId('account-github-status')).toContainText('octo');
	await expect(github.getByLabel('Or paste a token')).toHaveCount(0);
	expect(seen).toContain(`Bearer ${GOOD_TOKEN}`);

	// The picker: a search, the size, and the default branch preselected.
	await page.getByRole('link', { name: 'Repositories' }).click();
	await expect(page.getByTestId('repo-option')).toHaveCount(2);
	await page.getByTestId('repo-search').fill('other-repo');
	await expect(page.getByTestId('repo-option')).toHaveCount(1);
	await page.getByTestId('repo-option').click();
	await expect(page.getByTestId('repo-size')).toContainText('921.6 MB');
	await expect(page.getByTestId('size-warning')).toContainText('300.0 MB');

	await page.getByTestId('repo-search').fill(fullName);
	await page.getByTestId('repo-option').click();
	await expect(page.getByTestId('repo-size')).toContainText('12.3 KB');
	await expect(page.getByTestId('size-warning')).toHaveCount(0);
	const branch = page.getByTestId('branch-select');
	await expect(branch.locator('option')).toHaveCount(2);
	await expect(branch).toHaveValue('main');

	// The clone is real: `drafts` has one file fewer than `main`.
	await branch.selectOption('drafts');
	await page.getByTestId('clone-button').click();
	const copy = page.getByTestId('local-copy');
	await expect(copy).toContainText(fullName);
	await expect(copy).toContainText('drafts, 2 files');
	expect(git.authorized()).toBeGreaterThan(0);

	// Nothing on the device holds the token in the clear.
	const stored = await dumpBrowserStorage(page);
	expect(stored).toContain('gitnote-auth/tokens');
	expect(stored).toContain('[key extractable=false]');
	expect(stored).not.toContain(GOOD_TOKEN);

	// The sign-in and the copy survive a reload, and the copy reads offline.
	await page.reload();
	await expect(page.getByTestId('local-copy')).toContainText('drafts, 2 files');
	await expect(page.getByTestId('repo-option')).toHaveCount(2);
	await page.getByTestId('repo-search').fill(fullName);
	await page.getByTestId('repo-option').click();
	await expect(page.getByTestId('repo-on-device')).toBeVisible();

	// Signing out without asking for a wipe keeps the notes.
	await page.getByRole('link', { name: 'Accounts' }).click();
	await github.getByRole('button', { name: 'Sign out' }).click();
	const leaving = page.getByTestId('sign-out-github');
	await expect(page.getByTestId('sign-out-work')).toContainText(`${fullName}: 0 unpushed commits, 0 uncommitted files`);
	await leaving.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(github.getByLabel('Or paste a token')).toBeVisible();
	await page.getByRole('link', { name: 'Repositories' }).click();
	await expect(page.getByTestId('no-accounts')).toBeVisible();
	await expect(page.getByTestId('local-copy')).toContainText('drafts, 2 files');

	// Connect again, then sign out asking for the wipe.
	await page.getByRole('link', { name: 'Accounts' }).first().click();
	await github.getByLabel('Or paste a token').fill(GOOD_TOKEN);
	await github.getByRole('button', { name: 'Check and save' }).click();
	await github.getByRole('button', { name: 'Sign out' }).click();
	await leaving.getByRole('checkbox').check();
	await leaving.getByRole('button', { name: 'Sign out and delete' }).click();
	await expect(github.getByLabel('Or paste a token')).toBeVisible();
	await page.getByRole('link', { name: 'Repositories' }).click();
	await expect(page.getByTestId('no-accounts')).toBeVisible();
	await expect(page.getByTestId('local-copy')).toHaveCount(0);

	const after = await dumpBrowserStorage(page);
	expect(after).not.toContain('notes/a.md');
	expect(after).not.toContain(GOOD_TOKEN);
	expect(problems).toEqual([]);
});

test('a pasted GitLab token clones with the oauth2 git username', async ({ page }) => {
	const problems = collectBreakage(page);
	const { fullName } = await repoWithBranches();
	await serveApi(page, 'gitlab', GOOD_TOKEN, {
		'/projects?membership=true&simple=false&statistics=true&order_by=last_activity_at&per_page=100&page=1': [
			{ id: 41, path_with_namespace: fullName, default_branch: 'main', statistics: { repository_size: 5000 }, visibility: 'private', empty_repo: false },
			{ id: 43, path_with_namespace: 'octo/blank', default_branch: null, visibility: 'private', empty_repo: true }
		],
		'/projects/41/repository/branches?per_page=100&page=1': [{ name: 'main' }, { name: 'drafts' }]
	});
	const git = await serveGit(page, 'gitlab', GOOD_TOKEN);

	await page.goto('/connect');
	const gitlab = page.getByTestId('account-gitlab');
	await gitlab.getByLabel('Or paste a token').fill(GOOD_TOKEN);
	await gitlab.getByRole('button', { name: 'Check and save' }).click();
	await expect(page.getByTestId('account-gitlab-status')).toContainText('octo');

	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByRole('button', { name: /octo\/blank/ }).click();
	await expect(page.getByTestId('repo-empty')).toBeVisible();
	await expect(page.getByTestId('clone-button')).toHaveCount(0);

	await page.getByRole('button', { name: new RegExp(fullName) }).click();
	await expect(page.getByTestId('branch-select')).toHaveValue('main');
	await page.getByTestId('clone-button').click();
	await expect(page.getByTestId('local-copy')).toContainText('main, 3 files');
	expect(git.authorized()).toBeGreaterThan(0);
	expect(await dumpBrowserStorage(page)).not.toContain(GOOD_TOKEN);
	expect(problems).toEqual([]);
});

test.describe('the GitHub App sign-in', () => {
	/**
	 * Stands in for GitHub's sign-in page, which approves and redirects back.
	 * @param {import('@playwright/test').Page} page
	 * @returns {Promise<{ authorize: () => URL | null }>}
	 */
	async function serveAuthorizePage(page) {
		/** @type {URL | null} */
		let authorize = null;
		await page.route('https://github.com/login/oauth/authorize**', async (route) => {
			authorize = new URL(route.request().url());
			const back = new URL(String(authorize.searchParams.get('redirect_uri')));
			back.search = new URLSearchParams({ code: 'e2e-code', state: String(authorize.searchParams.get('state')) }).toString();
			await route.fulfill({ status: 302, headers: { location: back.href } });
		});
		return { authorize: () => authorize };
	}

	test('runs PKCE and state through the redirect and ends on the repo list', async ({ page }) => {
		const problems = collectBreakage(page);
		const { authorize } = await serveAuthorizePage(page);
		await serveApi(page, 'github', GOOD_TOKEN, { '/user/installations?per_page=100&page=1': { installations: [] } });
		/** @type {Record<string, string>} */
		let exchange = {};
		await page.route('**/api/oauth/github/token', async (route) => {
			exchange = route.request().postDataJSON();
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ access_token: GOOD_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 28800, refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' })
			});
		});

		await page.goto('/connect');
		await page.getByRole('button', { name: 'Sign in with GitHub' }).click();

		await expect(page).toHaveURL(/\/repos$/);
		await expect(page.getByTestId('no-repos')).toBeVisible();
		await expect(page.getByTestId('install-link')).toHaveAttribute('href', 'https://github.com/apps/gitnote-e2e/installations/new');

		const sent = /** @type {URL} */ (/** @type {unknown} */ (authorize()));
		expect(sent.searchParams.get('client_id')).toBe('e2e-github-client');
		expect(sent.searchParams.get('code_challenge')).toBe(createHash('sha256').update(exchange.code_verifier).digest('base64url'));
		expect(exchange.code).toBe('e2e-code');
		expect(exchange.redirect_uri).toBe(sent.searchParams.get('redirect_uri'));
		expect(exchange).not.toHaveProperty('client_secret');

		// Neither token, nor the verifier now that it is spent, stays readable.
		const stored = await dumpBrowserStorage(page);
		expect(stored).not.toContain(GOOD_TOKEN);
		expect(stored).not.toContain(REFRESH_TOKEN);
		expect(stored).not.toContain(exchange.code_verifier);

		await page.getByRole('link', { name: 'Accounts' }).click();
		await expect(page.getByTestId('account-github-status')).toContainText('signed in');
		expect(problems).toEqual([]);
	});

	test('the gitlab.com sign-in runs on the device under the production CSP, without the relay', async ({ page }) => {
		const problems = collectBreakage(page);
		await page.route('https://gitlab.com/oauth/authorize**', async (route) => {
			const url = new URL(route.request().url());
			const back = new URL(String(url.searchParams.get('redirect_uri')));
			back.search = new URLSearchParams({ code: 'e2e-code', state: String(url.searchParams.get('state')) }).toString();
			await route.fulfill({ status: 302, headers: { location: back.href } });
		});
		await serveApi(page, 'gitlab', GOOD_TOKEN, { '/projects?membership=true&simple=false&statistics=true&order_by=last_activity_at&per_page=100&page=1': [] });
		/** @type {URLSearchParams | null} */
		let exchange = null;
		await page.route('https://gitlab.com/oauth/token', async (route) => {
			exchange = new URLSearchParams(route.request().postData() ?? '');
			await route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ access_token: GOOD_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 7200, token_type: 'Bearer' }) });
		});

		await page.goto('/connect');
		await page.getByRole('button', { name: 'Sign in with GitLab' }).click();

		await expect(page).toHaveURL(/\/repos$/);
		await expect(page.getByTestId('no-repos')).toBeVisible();
		const sent = /** @type {URLSearchParams} */ (/** @type {unknown} */ (exchange));
		expect(sent.get('client_id')).toBe('e2e-gitlab-client');
		expect(sent.get('code')).toBe('e2e-code');
		expect(sent.get('code_verifier')).toBeTruthy();
		const stored = await dumpBrowserStorage(page);
		expect(stored).not.toContain(GOOD_TOKEN);
		expect(stored).not.toContain(REFRESH_TOKEN);
		expect(problems).toEqual([]);
	});

	test('refuses a redirect it did not start, and clears the code from the address bar', async ({ page }) => {
		let exchanged = false;
		await page.route('**/api/oauth/github/token', async (route) => {
			exchanged = true;
			await route.abort();
		});

		await page.goto('/auth/callback?code=attacker-code&state=forged');

		await expect(page.getByTestId('callback-error')).toContainText('did not start on this device');
		expect(page.url()).not.toContain('attacker-code');
		expect(exchanged).toBe(false);
		expect(await dumpBrowserStorage(page)).not.toContain('attacker-code');
	});

	test("shows the relay's reason when sign-in is not set up, rather than calling it an outage", async ({ page }) => {
		await serveAuthorizePage(page);
		await page.route('**/api/oauth/github/token', (route) =>
			route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'oauth_not_configured', message: 'GitHub sign-in is not configured on this relay.' }) })
		);

		await page.goto('/connect');
		await page.getByRole('button', { name: 'Sign in with GitHub' }).click();

		await expect(page.getByTestId('callback-error')).toContainText('GitHub sign-in is not configured on this relay.');
	});

	test('reports a declined sign-in', async ({ page }) => {
		await page.route('https://github.com/login/oauth/authorize**', async (route) => {
			const url = new URL(route.request().url());
			const back = new URL(String(url.searchParams.get('redirect_uri')));
			back.search = new URLSearchParams({ error: 'access_denied', state: String(url.searchParams.get('state')) }).toString();
			await route.fulfill({ status: 302, headers: { location: back.href } });
		});

		await page.goto('/connect');
		await page.getByRole('button', { name: 'Sign in with GitHub' }).click();

		await expect(page.getByTestId('callback-error')).toContainText('declined');
	});
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {ProviderId} [provider]
 * @param {string} [token]
 * @returns {Promise<void>}
 */
async function pasteToken(page, provider = 'github', token = GOOD_TOKEN) {
	await page.goto('/connect');
	const section = page.getByTestId(`account-${provider}`);
	await section.getByLabel('Or paste a token').fill(token);
	await section.getByRole('button', { name: 'Check and save' }).click();
	await expect(page.getByTestId(`account-${provider}-status`)).toContainText('octo');
}

/**
 * The picker's answers for a pasted GitHub token that sees these repos.
 * @param {{ id: number, fullName: string }[]} repos
 * @returns {Record<string, unknown>}
 */
function githubAnswers(repos) {
	/** @type {Record<string, unknown>} */
	const answers = { '/user/repos?per_page=100&sort=updated&page=1': repos.map(({ id, fullName }) => ({ id, full_name: fullName, default_branch: 'main', size: 12, private: true })) };
	for (const { fullName } of repos) answers[`/repos/${fullName}/branches?per_page=100&page=1`] = [{ name: 'main' }, { name: 'drafts' }];
	return answers;
}

/**
 * Clones a repo through the picker on `/repos`.
 * @param {import('@playwright/test').Page} page
 * @param {string} fullName
 * @returns {Promise<void>}
 */
async function cloneThroughPicker(page, fullName) {
	await page.goto('/repos');
	await page.getByRole('button', { name: new RegExp(fullName) }).click();
	await expect(page.getByTestId('branch-select').locator('option')).toHaveCount(2);
	await page.getByTestId('clone-button').click();
	await expect(page.getByTestId('local-copy').filter({ hasText: fullName })).toContainText('main, 3 files');
}

/**
 * Holds a repo's lock from a page, as another tab's pull or push would.
 * @param {import('@playwright/test').Page} page
 * @param {string} fullName
 * @returns {Promise<() => Promise<void>>} releases it
 */
async function holdRepoLock(page, fullName) {
	await page.evaluate(
		(name) =>
			new Promise((held) => {
				navigator.locks.request(name, () => {
					held(undefined);
					return new Promise((release) => {
						/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window)).releaseRepoLock = release;
					});
				});
			}),
		`gitnote:repo:github.com/${fullName}`
	);
	return () => page.evaluate(() => /** @type {{ releaseRepoLock: () => void }} */ (/** @type {unknown} */ (window)).releaseRepoLock());
}

test('a dead sign-in still asks for a new one on the repo page after a reload, and the copies stay', async ({ page }) => {
	const { id, fullName } = await repoWithBranches();
	await serveApi(page, 'github', GOOD_TOKEN, githubAnswers([{ id, fullName }]));
	await serveGit(page, 'github', GOOD_TOKEN);
	await pasteToken(page);
	await cloneThroughPicker(page, fullName);

	// The token dies. The first visit learns that from the provider.
	await page.route(`${PROVIDERS.github.api}/**`, (route) => route.fulfill({ status: 401, headers: CORS, body: '{"message":"Bad credentials"}' }));
	await page.reload();
	await expect(page.getByTestId('repos-error')).toContainText('sign-in has ended');

	// Later visits know already, and must say so without asking the provider.
	await page.reload();
	await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
	await expect(page.getByTestId('local-copy')).toContainText('main, 3 files');
	await page.getByRole('link', { name: 'Sign in again' }).click();
	await expect(page).toHaveURL(/\/connect$/);
});

test('an empty GitHub repo is named as empty instead of offering a branch that cannot be cloned', async ({ page }) => {
	await serveApi(page, 'github', GOOD_TOKEN, {
		'/user/repos?per_page=100&sort=updated&page=1': [{ id: 44, full_name: 'octo/blank', default_branch: 'main', size: 0, private: true }],
		'/repos/octo/blank/branches?per_page=100&page=1': []
	});
	await pasteToken(page);
	await page.goto('/repos');

	await page.getByTestId('repo-option').click();

	await expect(page.getByTestId('repo-empty')).toBeVisible();
	await expect(page.getByTestId('clone-button')).toHaveCount(0);
});

test('switching accounts ignores the slower answer from the account left behind', async ({ page }) => {
	await serveApi(page, 'github', GOOD_TOKEN, {});
	await serveApi(page, 'gitlab', GOOD_TOKEN, {
		'/projects?membership=true&simple=false&statistics=true&order_by=last_activity_at&per_page=100&page=1': [{ id: 50, path_with_namespace: 'octo/on-gitlab', default_branch: 'main', visibility: 'private', empty_repo: false }]
	});
	await pasteToken(page, 'github');
	await pasteToken(page, 'gitlab');

	/** @type {() => void} */
	let releaseGithub = () => {};
	const githubMayAnswer = new Promise((resolve) => {
		releaseGithub = () => resolve(undefined);
	});
	let githubAsked = false;
	await page.route(`${PROVIDERS.github.api}/user/repos**`, async (route) => {
		githubAsked = true;
		await githubMayAnswer;
		await route.fulfill({ status: 200, headers: CORS, body: JSON.stringify([{ id: 51, full_name: 'octo/on-github', default_branch: 'main', size: 1, private: true }]) });
	});

	await page.goto('/repos');
	await expect.poll(() => githubAsked).toBe(true);
	await page.getByRole('button', { name: 'GitLab', exact: true }).click();
	await expect(page.getByRole('button', { name: /octo\/on-gitlab/ })).toBeVisible();

	const answered = page.waitForEvent('requestfinished', (request) => request.url().includes('/user/repos'));
	releaseGithub();
	await answered;
	await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));

	await expect(page.getByRole('button', { name: /octo\/on-github/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /octo\/on-gitlab/ })).toBeVisible();
	await expect(page.getByRole('button', { name: 'GitLab', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a browser that refuses to record the clone reports it and lets the user try again', async ({ page }) => {
	const { id, fullName } = await repoWithBranches();
	await serveApi(page, 'github', GOOD_TOKEN, githubAnswers([{ id, fullName }]));
	await serveGit(page, 'github', GOOD_TOKEN);
	await pasteToken(page);
	await page.goto('/repos');
	await page.getByRole('button', { name: new RegExp(fullName) }).click();

	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		/**
		 * @this {Storage}
		 * @param {string} key
		 * @param {string} value
		 */
		Storage.prototype.setItem = function (key, value) {
			if (key.startsWith('gitnote.repo.')) throw new DOMException('quota', 'QuotaExceededError');
			original.call(this, key, value);
		};
	});
	await page.getByTestId('clone-button').click();

	await expect(page.getByTestId('repos-error')).toContainText('quota');
	await expect(page.getByTestId('clone-progress')).toHaveCount(0);
	await expect(page.getByTestId('clone-button')).toBeEnabled();
});

test('a finished clone the browser refuses to mark ready stays listed, counted and deletable', async ({ page }) => {
	const { id, fullName } = await repoWithBranches();
	await serveApi(page, 'github', GOOD_TOKEN, githubAnswers([{ id, fullName }]));
	await serveGit(page, 'github', GOOD_TOKEN);
	await pasteToken(page);
	await page.goto('/repos');
	await page.getByRole('button', { name: new RegExp(fullName) }).click();
	await expect(page.getByTestId('branch-select').locator('option')).toHaveCount(2);

	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		/**
		 * @this {Storage}
		 * @param {string} key
		 * @param {string} value
		 */
		Storage.prototype.setItem = function (key, value) {
			if (key.startsWith('gitnote.repo.') && value.includes('"ready":true')) throw new DOMException('quota', 'QuotaExceededError');
			original.call(this, key, value);
		};
	});
	await page.getByTestId('clone-button').click();

	await expect(page.getByTestId('repos-error')).toContainText('quota');
	await expect(page.getByTestId('local-copy')).toContainText(fullName);

	await page.goto('/connect');
	await page.getByTestId('account-github').getByRole('button', { name: 'Sign out' }).click();
	await expect(page.getByTestId('sign-out-work')).toContainText(fullName);
	await page.getByRole('button', { name: 'Keep signed in' }).click();

	// Cloning again finds the copy and records it properly.
	await page.goto('/repos');
	await page.getByRole('button', { name: new RegExp(fullName) }).click();
	await expect(page.getByTestId('branch-select').locator('option')).toHaveCount(2);
	await page.getByTestId('clone-button').click();
	await expect(page.getByTestId('local-copy')).toContainText('main, 3 files');
});

test('the repo page shows accounts and copies while another tab holds a repo lock', async ({ page, context }) => {
	const { id, fullName } = await repoWithBranches();
	const answers = githubAnswers([{ id, fullName }]);
	await serveApi(page, 'github', GOOD_TOKEN, answers);
	await serveGit(page, 'github', GOOD_TOKEN);
	await pasteToken(page);
	await cloneThroughPicker(page, fullName);

	const release = await holdRepoLock(page, fullName);
	const other = await context.newPage();
	await serveApi(other, 'github', GOOD_TOKEN, answers);
	await other.goto('/repos');

	await expect(other.getByTestId('repo-option')).toBeVisible();
	await expect(other.getByTestId('local-copy')).toContainText(fullName);
	await expect(other.getByTestId('local-copy-state')).toHaveText('main');

	await release();
	await expect(other.getByTestId('local-copy-state')).toHaveText('main, 3 files');
});

test('a copy another tab cloned first is recorded with the branch actually on the device', async ({ page, context }) => {
	const { id, fullName } = await repoWithBranches();
	const answers = githubAnswers([{ id, fullName }]);
	await serveApi(page, 'github', GOOD_TOKEN, answers);
	await serveGit(page, 'github', GOOD_TOKEN);
	await pasteToken(page);

	const other = await context.newPage();
	await serveApi(other, 'github', GOOD_TOKEN, answers);
	await serveGit(other, 'github', GOOD_TOKEN);
	await other.goto('/repos');
	await other.getByTestId('repo-option').click();
	await expect(other.getByTestId('branch-select').locator('option')).toHaveCount(2);

	await page.goto('/repos');
	await page.getByTestId('repo-option').click();
	await expect(page.getByTestId('branch-select').locator('option')).toHaveCount(2);
	await page.getByTestId('branch-select').selectOption('drafts');
	await page.getByTestId('clone-button').click();
	await expect(page.getByTestId('local-copy')).toContainText('drafts, 2 files');

	// The other tab's list is stale, and it asks for `main`.
	await expect(other.getByTestId('branch-select')).toHaveValue('main');
	await other.getByTestId('clone-button').click();

	await expect(other.getByTestId('local-copy')).toContainText('drafts, 2 files');
	await expect(other.getByTestId('repo-on-device')).toBeVisible();
	await page.reload();
	await expect(page.getByTestId('local-copy')).toContainText('drafts, 2 files');
});

test.describe('deleting copies', () => {
	test('sign-out recounts at confirmation, so a copy cloned meanwhile is shown before it is deleted', async ({ page, context }) => {
		const first = await repoWithBranches();
		const second = await repoWithBranches();
		const answers = githubAnswers([
			{ id: 61, fullName: first.fullName },
			{ id: 62, fullName: second.fullName }
		]);
		await serveApi(page, 'github', GOOD_TOKEN, answers);
		await serveGit(page, 'github', GOOD_TOKEN);
		await pasteToken(page);
		await cloneThroughPicker(page, first.fullName);

		await page.goto('/connect');
		const github = page.getByTestId('account-github');
		await github.getByRole('button', { name: 'Sign out' }).click();
		await expect(page.getByTestId('sign-out-work')).toHaveCount(1);
		await page.getByTestId('sign-out-github').getByRole('checkbox').check();

		const other = await context.newPage();
		await serveApi(other, 'github', GOOD_TOKEN, answers);
		await serveGit(other, 'github', GOOD_TOKEN);
		await cloneThroughPicker(other, second.fullName);
		await other.close();

		await github.getByRole('button', { name: 'Sign out and delete' }).click();
		await expect(page.getByTestId('sign-out-changed')).toBeVisible();
		await expect(page.getByTestId('sign-out-work')).toHaveCount(2);
		await expect(page.getByTestId('account-github-status')).toBeVisible();
		expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('gitnote.repo.')).length)).toBe(2);

		await github.getByRole('button', { name: 'Sign out and delete' }).click();
		await expect(github.getByLabel('Or paste a token')).toBeVisible();
		expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('gitnote.repo.')).length)).toBe(0);
	});

	test('the choice to stay signed in cannot be made once the deletion is running', async ({ page }) => {
		const { id, fullName } = await repoWithBranches();
		await serveApi(page, 'github', GOOD_TOKEN, githubAnswers([{ id, fullName }]));
		await serveGit(page, 'github', GOOD_TOKEN);
		await pasteToken(page);
		await cloneThroughPicker(page, fullName);

		await page.goto('/connect');
		const github = page.getByTestId('account-github');
		await github.getByRole('button', { name: 'Sign out' }).click();
		await page.getByTestId('sign-out-github').getByRole('checkbox').check();
		const keep = github.getByRole('button', { name: 'Keep signed in' });
		await expect(keep).toBeEnabled();

		const release = await holdRepoLock(page, fullName);
		await github.getByRole('button', { name: 'Sign out and delete' }).click();
		await expect(keep).toBeDisabled();

		await release();
		await expect(github.getByLabel('Or paste a token')).toBeVisible();
	});

	test('keeping a copy cannot be chosen once its deletion is running', async ({ page }) => {
		const { id, fullName } = await repoWithBranches();
		await serveApi(page, 'github', GOOD_TOKEN, githubAnswers([{ id, fullName }]));
		await serveGit(page, 'github', GOOD_TOKEN);
		await pasteToken(page);
		await cloneThroughPicker(page, fullName);

		await page.getByRole('button', { name: 'Delete from this device' }).click();
		const keep = page.getByRole('button', { name: 'Keep it' });
		await expect(keep).toBeEnabled();

		const release = await holdRepoLock(page, fullName);
		await page.getByRole('button', { name: 'Delete this copy' }).click();
		await expect(keep).toBeDisabled();

		await release();
		await expect(page.getByTestId('local-copy')).toHaveCount(0);
	});

	test('a wipe that fails keeps the sign-in and can be tried again', async ({ page }) => {
		const { id, fullName } = await repoWithBranches();
		await serveApi(page, 'github', GOOD_TOKEN, githubAnswers([{ id, fullName }]));
		await serveGit(page, 'github', GOOD_TOKEN);
		await pasteToken(page);
		await cloneThroughPicker(page, fullName);

		await page.goto('/connect');
		const github = page.getByTestId('account-github');
		await github.getByRole('button', { name: 'Sign out' }).click();
		await page.getByTestId('sign-out-github').getByRole('checkbox').check();

		await page.evaluate(() => {
			/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window)).restoreDelete = ((original) => () => {
				IDBObjectStore.prototype.delete = original;
			})(IDBObjectStore.prototype.delete);
			IDBObjectStore.prototype.delete = () => {
				throw new DOMException('storage refused', 'UnknownError');
			};
		});
		await github.getByRole('button', { name: 'Sign out and delete' }).click();

		await expect(page.getByTestId('account-github-error')).toContainText(`Could not delete ${fullName}`);
		await expect(page.getByTestId('sign-out-github')).toBeVisible();
		await expect(page.getByTestId('account-github-status')).toBeVisible();

		await page.evaluate(() => /** @type {{ restoreDelete: () => void }} */ (/** @type {unknown} */ (window)).restoreDelete());
		await github.getByRole('button', { name: 'Sign out and delete' }).click();

		await expect(github.getByLabel('Or paste a token')).toBeVisible();
		await page.goto('/repos');
		await expect(page.getByTestId('no-accounts')).toBeVisible();
		await expect(page.getByTestId('local-copy')).toHaveCount(0);
	});

	test('the repo page deletes a copy with no account, after saying what it holds', async ({ page }) => {
		const { id, fullName } = await repoWithBranches();
		await serveApi(page, 'github', GOOD_TOKEN, githubAnswers([{ id, fullName }]));
		await serveGit(page, 'github', GOOD_TOKEN);
		await pasteToken(page);
		await cloneThroughPicker(page, fullName);

		await page.goto('/connect');
		const github = page.getByTestId('account-github');
		await github.getByRole('button', { name: 'Sign out' }).click();
		await page.getByTestId('sign-out-github').getByRole('button', { name: 'Sign out', exact: true }).click();
		await expect(github.getByLabel('Or paste a token')).toBeVisible();

		await page.goto('/repos');
		await expect(page.getByTestId('no-accounts')).toBeVisible();
		await page.getByRole('button', { name: 'Delete from this device' }).click();
		await expect(page.getByTestId('remove-copy')).toContainText('0 unpushed commits, 0 uncommitted files');

		// Changing your mind keeps it.
		await page.getByRole('button', { name: 'Keep it' }).click();
		await expect(page.getByTestId('local-copy')).toContainText('main, 3 files');

		await page.getByRole('button', { name: 'Delete from this device' }).click();
		await page.getByRole('button', { name: 'Delete this copy' }).click();
		await expect(page.getByTestId('local-copy')).toHaveCount(0);
		await page.reload();
		await expect(page.getByTestId('no-accounts')).toBeVisible();
		await expect(page.getByTestId('local-copy')).toHaveCount(0);
		expect(await dumpBrowserStorage(page)).not.toContain('notes/a.md');
	});

	test('a clone cut off by a closed tab is listed as unfinished and can be deleted', async ({ page }) => {
		await page.goto('/repos');
		await page.evaluate(() => {
			const id = 'github.com/octo/cut-off';
			localStorage.setItem(`gitnote.repo.${id}`, JSON.stringify({ id, url: 'https://github.com/octo/cut-off.git', provider: 'github', fullName: 'octo/cut-off', branch: 'main', ready: false }));
		});
		await page.reload();

		await expect(page.getByTestId('local-copy-state')).toContainText('clone not finished');
		await page.getByRole('button', { name: 'Delete from this device' }).click();
		await page.getByRole('button', { name: 'Delete this copy' }).click();
		await expect(page.getByTestId('local-copy')).toHaveCount(0);
	});
});

test('with no account, the repo page offers to connect one', async ({ page }) => {
	await page.goto('/repos');

	await expect(page.getByTestId('no-accounts')).toBeVisible();
	await page.getByRole('link', { name: 'Connect one' }).click();
	await expect(page).toHaveURL(/\/connect$/);
});
