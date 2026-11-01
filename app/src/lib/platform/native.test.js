import { describe, expect, it, vi } from 'vitest';
import { callbackQuery, NATIVE_REDIRECT_URI, watchAppLifecycle, watchSignInReturn } from './native.js';

const CALLBACK = `${NATIVE_REDIRECT_URI}?code=abc&state=xyz`;

// The double's parts are inferred.
// eslint-disable-next-line jsdoc/require-returns
/**
 * The two ways Android hands the app a URL, and the Custom Tab.
 * @param {{ launchUrl?: string, launchFails?: boolean }} [options]
 */
function nativeDouble({ launchUrl, launchFails = false } = {}) {
	/** @type {Map<string, (event: { url?: string }) => void>} */
	const listeners = new Map();
	const remove = vi.fn(async () => undefined);
	const app = {
		addListener: vi.fn(async (/** @type {string} */ name, /** @type {(event: { url?: string }) => void} */ listener) => {
			listeners.set(name, listener);
			return { remove };
		}),
		getLaunchUrl: vi.fn(async () => {
			if (launchFails) throw new Error('no bridge');
			return launchUrl === undefined ? undefined : { url: launchUrl };
		})
	};
	const browser = { close: vi.fn(async () => undefined) };
	return { app: /** @type {import('@capacitor/app').AppPlugin} */ (/** @type {unknown} */ (app)), appCalls: app, browser, listeners, remove };
}

describe('callbackQuery', () => {
	it('returns the query of the exact callback', () => {
		expect(callbackQuery(CALLBACK)).toBe('?code=abc&state=xyz');
		expect(callbackQuery(NATIVE_REDIRECT_URI)).toBe('');
	});

	it.each(['gitnote://oauth/other?code=a', 'gitnote://evil/callback?code=a', 'https://oauth/callback?code=a', 'gitnote:oauth/callback?code=a', 'not a url', ''])('ignores %s', (url) => {
		expect(callbackQuery(url)).toBeNull();
	});
});

describe('watchSignInReturn', () => {
	it('opens the callback page for an awaited link that arrives while the app is alive, and closes the tab', async () => {
		const { app, browser, listeners } = nativeDouble();
		const open = vi.fn();
		const ignored = vi.fn();
		watchSignInReturn({ isAwaited: () => true, open, ignored, app, browser });
		await vi.waitFor(() => expect(listeners.has('appUrlOpen')).toBe(true));

		listeners.get('appUrlOpen')?.({ url: CALLBACK });

		expect(open).toHaveBeenCalledExactlyOnceWith('?code=abc&state=xyz');
		expect(browser.close).toHaveBeenCalledOnce();
		expect(ignored).not.toHaveBeenCalled();
	});

	it('reports a link nobody is waiting for without leaving the page or closing the real sign-in tab', async () => {
		const { app, browser, listeners } = nativeDouble();
		const open = vi.fn();
		const ignored = vi.fn();
		const awaited = new Set([CALLBACK]);
		watchSignInReturn({ isAwaited: (url) => awaited.has(url), open, ignored, app, browser });
		await vi.waitFor(() => expect(listeners.has('appUrlOpen')).toBe(true));

		listeners.get('appUrlOpen')?.({ url: `${NATIVE_REDIRECT_URI}?code=forged&state=none` });

		expect(ignored).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
		expect(browser.close).not.toHaveBeenCalled();

		listeners.get('appUrlOpen')?.({ url: CALLBACK });

		expect(open).toHaveBeenCalledExactlyOnceWith('?code=abc&state=xyz');
	});

	it('does not report the second delivery of a callback already handled', async () => {
		const { app, browser, listeners } = nativeDouble();
		const ignored = vi.fn();
		const awaited = new Set([CALLBACK]);
		const open = vi.fn(() => awaited.clear());
		watchSignInReturn({ isAwaited: (url) => awaited.has(url), open, ignored, app, browser });
		await vi.waitFor(() => expect(listeners.has('appUrlOpen')).toBe(true));

		listeners.get('appUrlOpen')?.({ url: CALLBACK });
		listeners.get('appUrlOpen')?.({ url: CALLBACK });

		expect(open).toHaveBeenCalledOnce();
		expect(ignored).not.toHaveBeenCalled();
	});

	it('ignores any other link', async () => {
		const { app, browser, listeners } = nativeDouble();
		const open = vi.fn();
		watchSignInReturn({ isAwaited: () => true, open, ignored: vi.fn(), app, browser });
		await vi.waitFor(() => expect(listeners.has('appUrlOpen')).toBe(true));

		listeners.get('appUrlOpen')?.({ url: 'gitnote://oauth/other?code=a' });

		expect(open).not.toHaveBeenCalled();
		expect(browser.close).not.toHaveBeenCalled();
	});

	it('finishes a sign-in whose callback launched the app', async () => {
		const { app, browser } = nativeDouble({ launchUrl: CALLBACK });
		const open = vi.fn();
		watchSignInReturn({ isAwaited: (url) => url === CALLBACK, open, ignored: vi.fn(), app, browser });
		await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('?code=abc&state=xyz'));
	});

	it('drops a launch URL from a sign-in that is no longer awaited', async () => {
		const { app, browser } = nativeDouble({ launchUrl: CALLBACK });
		const open = vi.fn();
		const isAwaited = vi.fn(() => false);
		watchSignInReturn({ isAwaited, open, ignored: vi.fn(), app, browser });
		await vi.waitFor(() => expect(isAwaited).toHaveBeenCalled());
		expect(open).not.toHaveBeenCalled();
	});

	it('delivers a callback once when Android reports it both ways', async () => {
		const { app, browser, listeners } = nativeDouble({ launchUrl: CALLBACK });
		const open = vi.fn();
		watchSignInReturn({ isAwaited: () => true, open, ignored: vi.fn(), app, browser });
		await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());

		listeners.get('appUrlOpen')?.({ url: CALLBACK });

		expect(open).toHaveBeenCalledOnce();
	});

	it('still opens the page when the tab cannot be closed', async () => {
		const { app, browser, listeners } = nativeDouble();
		browser.close.mockRejectedValue(new Error('no tab'));
		const open = vi.fn();
		watchSignInReturn({ isAwaited: () => true, open, ignored: vi.fn(), app, browser });
		await vi.waitFor(() => expect(listeners.has('appUrlOpen')).toBe(true));

		listeners.get('appUrlOpen')?.({ url: CALLBACK });

		expect(open).toHaveBeenCalledOnce();
	});

	it('keeps listening for links when the launch URL cannot be read', async () => {
		const { app, browser, listeners } = nativeDouble({ launchFails: true });
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const open = vi.fn();
		watchSignInReturn({ isAwaited: () => true, open, ignored: vi.fn(), app, browser });
		await vi.waitFor(() => expect(logged).toHaveBeenCalled());
		logged.mockRestore();

		listeners.get('appUrlOpen')?.({ url: CALLBACK });

		expect(open).toHaveBeenCalledOnce();
	});

	it('removes its listener when stopped', async () => {
		const { app, browser, remove } = nativeDouble();
		const stop = watchSignInReturn({ isAwaited: () => true, open: vi.fn(), ignored: vi.fn(), app, browser });
		stop();
		await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
	});
});

describe('watchAppLifecycle', () => {
	it('passes pause and resume on, and stops when told', async () => {
		const { app, listeners, remove } = nativeDouble();
		const pause = vi.fn();
		const resume = vi.fn();
		const stop = watchAppLifecycle({ pause, resume }, app, true);

		listeners.get('pause')?.({});
		listeners.get('resume')?.({});
		expect(pause).toHaveBeenCalledOnce();
		expect(resume).toHaveBeenCalledOnce();

		stop();
		await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
	});

	it('does nothing on the web', () => {
		const { app, appCalls } = nativeDouble();
		const stop = watchAppLifecycle({ pause: vi.fn(), resume: vi.fn() }, app, false);
		expect(appCalls.addListener).not.toHaveBeenCalled();
		expect(stop).not.toThrow();
	});
});
