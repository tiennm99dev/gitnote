import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { LIVE_ORIGIN } from '../scripts/live-origin.js';
import { createRemote, remoteHead, showRemote } from '../test/remote-repo.js';
import { E2E_GIT_PORT, E2E_GIT_ROOT } from './git-engine-ports.js';
import { installNativeShell, NATIVE_ORIGIN } from './native-shell.js';
import { collectBreakage, GOOD_TOKEN, PROVIDERS, REFRESH_TOKEN, serveApi, serveGit } from './provider-fixtures.js';

const CALLBACK = 'gitnote://oauth/callback';
const RELAY = LIVE_ORIGIN;
const TOKEN_ANSWER = { access_token: GOOD_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 28800, refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' };

/** @typedef {Awaited<ReturnType<typeof installNativeShell>>} Device */

test.describe.configure({ timeout: 60_000 });

/**
 * Answers the GitHub code exchange the relay would forward, and records the request.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ body: Record<string, string> | null, origin: string | null }>}
 */
async function serveGithubExchange(page) {
	/** @type {{ body: Record<string, string> | null, origin: string | null }} */
	const exchange = { body: null, origin: null };
	await page.route(`${RELAY}/api/oauth/github/token`, async (route) => {
		exchange.body = route.request().postDataJSON();
		exchange.origin = await route.request().headerValue('origin');
		await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': NATIVE_ORIGIN }, body: JSON.stringify(TOKEN_ANSWER) });
	});
	return exchange;
}

/**
 * Taps the sign-in button and waits for the Custom Tab.
 * @param {import('@playwright/test').Page} page
 * @param {Device} device
 * @param {string} name the button's label
 * @returns {Promise<URL>} the page the tab opened
 */
async function startSignIn(page, device, name) {
	await page.goto(`${NATIVE_ORIGIN}/connect`);
	await page.getByRole('button', { name }).click();
	await expect.poll(() => device.openedInTab()).toBeTruthy();
	return new URL(String(device.openedInTab()));
}

/**
 * @param {URL} authorize
 * @returns {string} the link the provider redirects the tab to
 */
const returnLink = (authorize) => `${CALLBACK}?code=e2e-code&state=${authorize.searchParams.get('state')}`;

test('the Android build boots under its own policy, with the bridge inline', async ({ page }) => {
	const device = await installNativeShell(page);
	const problems = collectBreakage(page);
	/** @type {string[]} */
	const refused = [];
	page.on('console', (message) => {
		if (/Content Security Policy/.test(message.text())) refused.push(message.text());
	});

	const response = await page.goto(`${NATIVE_ORIGIN}/`);
	await expect(page.getByTestId('app-title')).toBeVisible();

	const html = await response?.text();
	const scriptSrc = /script-src ([^;]+);/.exec(String(html))?.[1];
	expect(scriptSrc).toBe("'self' 'unsafe-inline'");
	expect(await page.evaluate(() => Reflect.get(globalThis, 'Capacitor').getPlatform())).toBe('android');
	await expect.poll(() => device.calls.some((call) => call.methodName === 'getLaunchUrl')).toBe(true);
	expect(refused).toEqual([]);
	expect(problems).toEqual([]);
});

test('GitHub sign-in leaves for the Custom Tab, returns by app link, and stores tokens only in secure storage', async ({ page }) => {
	const device = await installNativeShell(page);
	const problems = collectBreakage(page);
	await serveApi(page, 'github', GOOD_TOKEN, { '/user/installations?per_page=100&page=1': { installations: [] } });
	const exchange = await serveGithubExchange(page);

	const authorize = await startSignIn(page, device, 'Sign in with GitHub');

	expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
	expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);
	// OAuth never runs inside the WebView.
	expect(page.url()).toBe(`${NATIVE_ORIGIN}/connect`);

	await expect.poll(() => device.isListening('appUrlOpen')).toBe(true);
	await device.fire('appUrlOpen', { url: returnLink(authorize) });

	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/repos`);
	await expect(page.getByTestId('no-repos')).toBeVisible();
	expect(device.tabCloses()).toBe(1);
	expect(exchange.origin).toBe(NATIVE_ORIGIN);
	expect(exchange.body?.redirect_uri).toBe(CALLBACK);
	expect(authorize.searchParams.get('code_challenge')).toBe(createHash('sha256').update(String(exchange.body?.code_verifier)).digest('base64url'));

	const stored = JSON.parse(String([...device.secure.values()][0]));
	expect(stored).toMatchObject({ kind: 'oauth', accessToken: GOOD_TOKEN, refreshToken: REFRESH_TOKEN, redirectUri: CALLBACK });
	const webStorage = await page.evaluate(async () => ({ local: JSON.stringify(globalThis.localStorage), databases: (await globalThis.indexedDB.databases()).map((database) => database.name) }));
	expect(webStorage.local).not.toContain(GOOD_TOKEN);
	expect(webStorage.databases).not.toContain('gitnote-auth');

	// The sign-in outlives the page.
	await page.goto(`${NATIVE_ORIGIN}/connect`);
	await expect(page.getByTestId('account-github-status')).toContainText('signed in');
	expect(problems).toEqual([]);
});

test('GitLab sign-in returns by app link and exchanges its code on the device', async ({ page }) => {
	const device = await installNativeShell(page);
	const problems = collectBreakage(page);
	await serveApi(page, 'gitlab', GOOD_TOKEN, { '/projects?membership=true&simple=false&statistics=true&order_by=last_activity_at&per_page=100&page=1': [] });
	/** @type {URLSearchParams | null} */
	let exchange = null;
	await page.route('https://gitlab.com/oauth/token', async (route) => {
		exchange = new URLSearchParams(route.request().postData() ?? '');
		await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(TOKEN_ANSWER) });
	});

	const authorize = await startSignIn(page, device, 'Sign in with GitLab');
	expect(authorize.origin).toBe('https://gitlab.com');
	expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);

	await expect.poll(() => device.isListening('appUrlOpen')).toBe(true);
	await device.fire('appUrlOpen', { url: returnLink(authorize) });

	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/repos`);
	expect(/** @type {URLSearchParams} */ (/** @type {unknown} */ (exchange)).get('redirect_uri')).toBe(CALLBACK);
	expect([...device.secure.values()][0]).toContain(GOOD_TOKEN);
	expect(problems).toEqual([]);
});

test('a callback that launches the app finishes the sign-in, and the same launch URL later is ignored', async ({ page }) => {
	const device = await installNativeShell(page);
	await serveApi(page, 'github', GOOD_TOKEN, { '/user/installations?per_page=100&page=1': { installations: [] } });
	const exchange = await serveGithubExchange(page);

	const authorize = await startSignIn(page, device, 'Sign in with GitHub');

	// Android killed the app behind the Custom Tab, and the callback starts it again.
	device.device.launchUrl = returnLink(authorize);
	await page.goto(`${NATIVE_ORIGIN}/`);
	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/repos`);
	expect(exchange.body?.code).toBe('e2e-code');

	// Android gives the original intent back when the task is recreated from Recents.
	exchange.body = null;
	await page.goto(`${NATIVE_ORIGIN}/`);
	await expect.poll(() => device.calls.filter((call) => call.methodName === 'getLaunchUrl').length).toBeGreaterThan(1);
	await expect(page.getByTestId('app-title')).toBeVisible();
	await page.waitForTimeout(250);
	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/`);
	expect(exchange.body).toBeNull();
});

test('an app link this device did not ask for stays on the page and says so, and other links do nothing', async ({ page }) => {
	const device = await installNativeShell(page);
	await page.goto(`${NATIVE_ORIGIN}/connect`);
	await expect.poll(() => device.isListening('appUrlOpen')).toBe(true);

	await device.fire('appUrlOpen', { url: 'gitnote://oauth/elsewhere?code=stolen&state=none' });
	await page.waitForTimeout(250);
	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/connect`);
	await expect(page.getByTestId('sign-in-link-ignored')).toBeHidden();

	await device.fire('appUrlOpen', { url: `${CALLBACK}?code=stolen&state=none` });
	await expect(page.getByTestId('sign-in-link-ignored')).toBeVisible();
	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/connect`);
	expect(device.secure.size).toBe(0);

	await page.getByTestId('sign-in-link-ignored').getByRole('button', { name: 'Dismiss' }).click();
	await expect(page.getByTestId('sign-in-link-ignored')).toBeHidden();
});

test('an unawaited app link during a sign-in makes no close call and keeps the sign-in pending', async ({ page }) => {
	const device = await installNativeShell(page);
	await serveApi(page, 'github', GOOD_TOKEN, { '/user/installations?per_page=100&page=1': { installations: [] } });
	const exchange = await serveGithubExchange(page);
	const authorize = await startSignIn(page, device, 'Sign in with GitHub');
	await expect.poll(() => device.isListening('appUrlOpen')).toBe(true);

	await device.fire('appUrlOpen', { url: `${CALLBACK}?code=forged&state=none` });
	await expect(page.getByTestId('sign-in-link-ignored')).toBeVisible();
	expect(device.tabCloses()).toBe(0);

	await device.fire('appUrlOpen', { url: returnLink(authorize) });
	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/repos`);
	expect(exchange.body?.code).toBe('e2e-code');
	expect([...device.secure.values()][0]).toContain(GOOD_TOKEN);
	await expect(page.getByTestId('sign-in-link-ignored')).toBeHidden();
});

test('the callback page handles a second sign-in that returns while it shows the first one failing', async ({ page }) => {
	const device = await installNativeShell(page);
	await serveApi(page, 'gitlab', GOOD_TOKEN, { '/projects?membership=true&simple=false&statistics=true&order_by=last_activity_at&per_page=100&page=1': [] });
	await page.route(`${RELAY}/api/oauth/github/token`, (route) => route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': NATIVE_ORIGIN }, body: '{"error":"bad_gateway","message":"down"}' }));
	await page.route('https://gitlab.com/oauth/token', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(TOKEN_ANSWER) }));

	const github = await startSignIn(page, device, 'Sign in with GitHub');
	const gitlab = await startSignIn(page, device, 'Sign in with GitLab');
	await expect.poll(() => device.isListening('appUrlOpen')).toBe(true);

	await device.fire('appUrlOpen', { url: returnLink(github) });
	await expect(page.getByTestId('callback-error')).toBeVisible();
	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/auth/callback`);

	await device.fire('appUrlOpen', { url: returnLink(gitlab) });
	await expect(page).toHaveURL(`${NATIVE_ORIGIN}/repos`);
	expect([...device.secure.values()][0]).toContain(GOOD_TOKEN);
});

test('coming back to the app re-reads the repository list, so a new GitHub App install shows up', async ({ page }) => {
	const device = await installNativeShell(page);
	const signedIn = { '/user/installations?per_page=100&page=1': { installations: [] } };
	await serveApi(page, 'github', GOOD_TOKEN, { ...signedIn, '/user/repos?per_page=100&sort=updated&page=1': [] });

	await page.goto(`${NATIVE_ORIGIN}/connect`);
	const github = page.getByTestId('account-github');
	await github.getByLabel('Or paste a token').fill(GOOD_TOKEN);
	await github.getByRole('button', { name: 'Check and save' }).click();
	await expect(page.getByTestId('account-github-status')).toContainText('octo');
	await page.getByRole('link', { name: 'Repositories' }).click();
	await expect(page.getByTestId('no-repos')).toBeVisible();
	await expect.poll(() => device.isListening('resume')).toBe(true);

	await serveApi(page, 'github', GOOD_TOKEN, {
		...signedIn,
		'/user/repos?per_page=100&sort=updated&page=1': [{ id: 41, full_name: 'octo/notes', default_branch: 'main', size: 12, private: true }]
	});
	await device.fire('resume');

	await expect(page.getByTestId('repo-option')).toHaveText(/octo\/notes/);
	await expect(page.getByTestId('no-repos')).toBeHidden();
});

test('git goes through the relay by its full address, and pausing commits locally, then resuming pushes', async ({ page }) => {
	const device = await installNativeShell(page);
	const problems = collectBreakage(page);
	const remote = await createRemote({ 'notes.md': 'first\n' }, { root: E2E_GIT_ROOT, port: E2E_GIT_PORT });
	const fullName = new URL(remote.url).pathname.slice(1).replace(/\.git$/, '');
	await serveApi(page, 'github', GOOD_TOKEN, {
		'/user/repos?per_page=100&sort=updated&page=1': [{ id: 41, full_name: fullName, default_branch: 'main', size: 12, private: true }],
		[`/repos/${fullName}/branches?per_page=100&page=1`]: [{ name: 'main' }]
	});
	const git = await serveGit(page, 'github', GOOD_TOKEN, { crossOrigin: true });
	/** @type {string[]} */
	const gitHosts = [];
	page.on('request', (request) => {
		if (request.url().includes(`/api/git/${PROVIDERS.github.host}/`)) gitHosts.push(new URL(request.url()).origin);
	});

	await page.goto(`${NATIVE_ORIGIN}/settings`);
	await page.getByTestId('autosave-toggle').check();
	await page.getByTestId('autosave-interval').selectOption('30');
	await page.getByTestId('settings-save').click();
	await expect(page.getByTestId('settings-saved')).toBeVisible();

	await page.goto(`${NATIVE_ORIGIN}/connect`);
	const github = page.getByTestId('account-github');
	await github.getByLabel('Or paste a token').fill(GOOD_TOKEN);
	await github.getByRole('button', { name: 'Check and save' }).click();
	await expect(page.getByTestId('account-github-status')).toContainText('octo');
	expect([...device.secure.values()][0]).toContain(GOOD_TOKEN);

	// Playwright answers the preflight of a routed request itself, so the relay's real
	// answer here is only the final Access-Control-Allow-Origin. Its preflight has its
	// own test, against the headers a real clone sends, in `lib/git/http.test.js`.
	await page.getByRole('link', { name: 'Repositories' }).click();
	await page.getByTestId('repo-option').click();
	await page.getByTestId('clone-button').click();
	await page.getByTestId('open-copy').click();
	expect(git.authorized()).toBeGreaterThan(0);
	expect(new Set(gitHosts)).toEqual(new Set([RELAY]));

	await page.getByTestId('tree-file').first().click();
	await expect(page.getByTestId('sync-branch')).toHaveText('main');
	await expect.poll(() => device.isListening('pause')).toBe(true);
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByTestId('note-editor').locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.type('written on the phone\n');
	await expect(page.getByTestId('tree-unsaved')).toBeVisible();

	const before = await remoteHead(remote);

	// The WebView's own visibility never changes here, so only the app's event can do this.
	await device.fire('pause');
	await expect(page.getByTestId('sync-ahead')).toHaveText('1 unpushed commit');
	expect(await remoteHead(remote)).toBe(before);

	await device.fire('resume');
	await expect(page.getByTestId('sync-ahead')).toHaveText('0 unpushed commits');
	await expect.poll(() => showRemote(remote, 'main:notes.md')).toBe('written on the phone\n');
	expect(problems).toEqual([]);
});
