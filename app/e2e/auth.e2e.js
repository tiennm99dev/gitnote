/* global indexedDB */
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createRemote, pushFromElsewhere, runGit } from '../test/remote-repo.js';
import { E2E_GIT_PORT, E2E_GIT_ROOT, E2E_RELAY_PORT } from './git-engine-ports.js';

/**
 * The provider's REST API is answered here and its sign-in pages are stood in
 * for, because this suite must not touch github.com or gitlab.com. Git traffic
 * is real: the app's request for the provider's host is forwarded to the real
 * relay in front of a local `git http-backend`, and the app's code, build and
 * CSP are the production ones.
 */

const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

/** Fixture values for local stand-ins. None of them is a secret. */
const GOOD_TOKEN = 'e2e_fixture_token_abcdef';
const BAD_TOKEN = 'e2e_refused_token_abcdef';
const REFRESH_TOKEN = 'e2e_fixture_refresh_abcdef';

/** @typedef {'github' | 'gitlab'} ProviderId */

const PROVIDERS = /** @type {const} */ ({
	github: { host: 'github.com', api: 'https://api.github.com', gitUsername: 'x-access-token', user: { login: 'octo', name: 'Octo', email: null } },
	gitlab: { host: 'gitlab.com', api: 'https://gitlab.com/api/v4', gitUsername: 'oauth2', user: { username: 'octo', name: 'Octo', email: null } }
});

/**
 * @param {string} token
 * @param {ProviderId} provider
 * @returns {string} the Authorization header git must send
 */
function gitAuthorization(token, provider) {
	return `Basic ${Buffer.from(`${PROVIDERS[provider].gitUsername}:${token}`).toString('base64')}`;
}

/**
 * Forwards the app's git requests for a provider's host to the local server,
 * refusing anything without the right credential, as a private repo does.
 * @param {import('@playwright/test').Page} page
 * @param {ProviderId} provider
 * @param {string} token
 * @returns {Promise<{ authorized: () => number }>}
 */
async function serveGit(page, provider, token) {
	const { host } = PROVIDERS[provider];
	let authorized = 0;
	await page.route(new RegExp(`/api/git/${host.replace('.', '\\.')}/`), async (route) => {
		const request = route.request();
		if ((await request.headerValue('authorization')) !== gitAuthorization(token, provider)) {
			await route.fulfill({ status: 401, headers: { 'www-authenticate': 'Basic realm="fixture"', 'content-type': 'text/plain' }, body: 'sign in' });
			return;
		}
		authorized += 1;
		const url = new URL(request.url());
		const path = url.pathname.replace(`/api/git/${host}/`, `/api/git/localhost:${E2E_GIT_PORT}/`);
		const headers = { ...request.headers() };
		// The test runner is the relay's client here, not the page's origin.
		for (const name of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) delete headers[name];
		const response = await route.fetch({ url: `http://127.0.0.1:${E2E_RELAY_PORT}${path}${url.search}`, headers });
		await route.fulfill({ response });
	});
	return { authorized: () => authorized };
}

/**
 * Stands in for the provider's REST API.
 * @param {import('@playwright/test').Page} page
 * @param {ProviderId} provider
 * @param {string} token the only bearer token it accepts
 * @param {Record<string, unknown>} answers JSON by path and query, after the API root
 * @returns {Promise<string[]>} the bearer headers it saw
 */
async function serveApi(page, provider, token, answers) {
	const { api, user } = PROVIDERS[provider];
	/** @type {string[]} */
	const seen = [];
	await page.route(`${api}/**`, async (route) => {
		const request = route.request();
		const authorization = (await request.headerValue('authorization')) ?? '';
		seen.push(authorization);
		if (authorization !== `Bearer ${token}`) {
			await route.fulfill({ status: 401, headers: CORS, body: '{"message":"Bad credentials"}' });
			return;
		}
		const path = request.url().slice(api.length);
		const answer = path === '/user' ? user : answers[path];
		await route.fulfill(answer === undefined ? { status: 404, headers: CORS, body: '{"message":"Not Found"}' } : { status: 200, headers: CORS, body: JSON.stringify(answer) });
	});
	return seen;
}

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
 * Collects what would mean the production build broke under its own CSP.
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function collectBreakage(page) {
	/** @type {string[]} */
	const problems = [];
	page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) problems.push(message.text());
	});
	return problems;
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

test('with no account, the repo page offers to connect one', async ({ page }) => {
	await page.goto('/repos');

	await expect(page.getByTestId('no-accounts')).toBeVisible();
	await page.getByRole('link', { name: 'Connect one' }).click();
	await expect(page).toHaveURL(/\/connect$/);
});
