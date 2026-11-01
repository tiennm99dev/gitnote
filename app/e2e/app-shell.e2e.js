import { expect, test } from '@playwright/test';

/**
 * Collects uncaught page errors, console errors and failed network responses
 * while a test runs.
 *
 * Network failures are tracked per response, so a missing script, stylesheet
 * or icon always fails the test. `allowedUrls` lists absolute URLs whose error
 * status is expected (a deep-link document that a static preview server
 * answers with 404 while still serving the SPA shell); only those responses,
 * and the browser's matching "Failed to load resource" console line, are
 * ignored.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} [allowedUrls]
 * @returns {string[]}
 */
function collectErrors(page, allowedUrls = []) {
	/** @type {string[]} */
	const errors = [];
	const allowed = new Set(allowedUrls);
	page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() !== 'error') return;
		const text = message.text();
		if (text.startsWith('Failed to load resource') && allowed.has(message.location().url)) return;
		errors.push(`console: ${text}`);
	});
	page.on('response', (response) => {
		if (response.status() >= 400 && !allowed.has(response.url())) {
			errors.push(`response ${response.status()}: ${response.url()}`);
		}
	});
	page.on('requestfailed', (request) => {
		errors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText})`);
	});
	return errors;
}

test('serves the app shell without errors', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/', { waitUntil: 'networkidle' });
	await expect(page).toHaveTitle('gitnote');
	await expect(page.getByTestId('app-title')).toHaveText('gitnote');
	expect(errors).toEqual([]);
});

test('declares a loadable icon in the static shell', async ({ request }) => {
	// The app renders only on the client, so the icon must be in the HTML the
	// server sends; otherwise the browser falls back to a missing /favicon.ico.
	const shell = await request.get('/');
	const href = /<link rel="icon" href="([^"]+)"/.exec(await shell.text())?.[1];
	expect(href).toBeTruthy();
	const icon = await request.get(new URL(String(href), shell.url()).href);
	expect(icon.status()).toBe(200);
	expect(icon.headers()['content-type']).toContain('image/svg+xml');
});

test('applies Tailwind utility classes', async ({ page }) => {
	await page.goto('/');
	// `max-w-2xl` (42rem) on <main> only takes effect when the Tailwind build ran.
	await expect(page.locator('main')).toHaveCSS('max-width', '672px');
});

test('boots the client router on unknown paths', async ({ page, baseURL }) => {
	const deepLink = new URL('/some/deep/link', baseURL).href;
	const errors = collectErrors(page, [deepLink]);
	await page.goto(deepLink, { waitUntil: 'networkidle' });
	// The page has no server rendering, so this heading can only come from the
	// client router rendering its not-found page inside the SPA shell.
	await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
	await expect(page.getByText('Not Found')).toBeVisible();
	expect(errors).toEqual([]);
});
