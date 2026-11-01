import { expect, test } from '@playwright/test';

/**
 * Collects uncaught page errors and console errors while a test runs.
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function collectErrors(page) {
	/** @type {string[]} */
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text());
	});
	return errors;
}

test('serves the app shell without errors', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/');
	await expect(page).toHaveTitle('gitnote');
	await expect(page.getByTestId('app-title')).toHaveText('gitnote');
	expect(errors).toEqual([]);
});

test('applies Tailwind utility classes', async ({ page }) => {
	await page.goto('/');
	// `max-w-2xl` (42rem) on <main> only takes effect when the Tailwind build ran.
	await expect(page.locator('main')).toHaveCSS('max-width', '672px');
});

test('boots the client router on unknown paths', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/some/deep/link');
	// The page has no server rendering, so this heading can only come from the
	// client router rendering its not-found page inside the SPA shell.
	await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
	await expect(page.getByText('Not Found')).toBeVisible();
	// The document request itself answers 404, which the browser logs.
	expect(errors.filter((message) => !message.includes('404'))).toEqual([]);
});
