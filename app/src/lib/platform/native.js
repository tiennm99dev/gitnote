/**
 * What differs when the app runs inside the Capacitor WebView: the page's origin
 * is `https://localhost`, so the relay needs its full address; sign-in leaves for
 * a Custom Tab and comes back as an app link; and the app's own pause and resume
 * events say when it is in the background. On the web every helper here falls back
 * to the page's own behaviour.
 */

import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

/** The relay's origin; its routes all live under `/api`. */
const RELAY_ORIGIN = 'https://gitnote.miti99.dev';

/** Registered on both sign-in apps; `AndroidManifest.xml` routes it here. */
export const NATIVE_REDIRECT_URI = 'gitnote://oauth/callback';

/**
 * @returns {boolean} running inside the Android app
 */
export const isNative = () => Capacitor.isNativePlatform();

/**
 * @returns {string | undefined} undefined on the web, where the relay is the page's own origin
 */
export const relayOrigin = () => (isNative() ? RELAY_ORIGIN : undefined);

/**
 * @returns {string | undefined} undefined on the web, where the callback is a page of this site
 */
export const signInRedirectUri = () => (isNative() ? NATIVE_REDIRECT_URI : undefined);

/**
 * Sends the user to a provider's sign-in page: a Custom Tab on Android, because
 * OAuth must never run inside the WebView, and this same tab on the web.
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function openSignInPage(url) {
	if (isNative()) await Browser.open({ url });
	else location.assign(url);
}

/**
 * @param {string} url what the app was opened with
 * @returns {string | null} its query, when it is exactly the sign-in callback
 */
export function callbackQuery(url) {
	if (!URL.canParse(url)) return null;
	const { protocol, host, pathname, search } = new URL(url);
	const expected = new URL(NATIVE_REDIRECT_URI);
	return protocol === expected.protocol && host === expected.host && pathname === expected.pathname ? search : null;
}

/**
 * Takes sign-in callbacks from both ways Android delivers them: `appUrlOpen` when
 * the app is alive, `getLaunchUrl` when the callback launched it.
 *
 * Any website or app can fire this link, so one this device is not waiting for
 * stays out of the way: it keeps the open page and the pending sign-in, and makes
 * no close call. Android may still drop the Custom Tab, because the link brings the
 * singleTask activity forward. An `appUrlOpen` like that is reported. A launch URL
 * like that is dropped quietly, because Android hands the original launch intent
 * back whenever the task is recreated from Recents, so it may be a sign-in that
 * finished days ago.
 * @param {object} options
 * @param {(url: string) => boolean} options.isAwaited whether this device is waiting for that callback
 * @param {(query: string) => unknown} options.open shows the callback page with this query
 * @param {() => void} options.ignored tells the user a sign-in link was not used
 * @param {Pick<typeof App, 'addListener' | 'getLaunchUrl'>} [options.app]
 * @param {Pick<typeof Browser, 'close'>} [options.browser]
 * @returns {() => void} stops listening
 */
export function watchSignInReturn({ isAwaited, open, ignored, app = App, browser = Browser }) {
	/**
	 * Android can report one launch both ways.
	 * @type {Set<string>}
	 */
	const delivered = new Set();

	/**
	 * @param {string} url
	 * @param {() => void} [unawaited]
	 */
	const receive = (url, unawaited) => {
		const query = callbackQuery(url);
		if (query === null || delivered.has(url)) return;
		if (!isAwaited(url)) {
			unawaited?.();
			return;
		}
		delivered.add(url);
		// The tab may already be gone, and leaving it open harms nothing.
		browser.close().catch(() => undefined);
		open(query);
	};

	const listening = app.addListener('appUrlOpen', ({ url }) => receive(url, ignored));
	app
		.getLaunchUrl()
		.then((launch) => {
			if (launch?.url) receive(launch.url);
		})
		.catch((/** @type {unknown} */ error) => console.error('Could not read the launch URL.', error));
	listening.catch((/** @type {unknown} */ error) => console.error('Could not listen for app links.', error));

	return () => {
		listening.then((handle) => handle.remove()).catch(() => undefined);
	};
}

/**
 * Calls back when the Android app goes to the background and returns. It does
 * nothing on the web, where `visibilitychange` says the same.
 * @param {object} handlers
 * @param {() => void} handlers.pause
 * @param {() => void} handlers.resume
 * @param {Pick<typeof App, 'addListener'>} [app]
 * @param {boolean} [native]
 * @returns {() => void} stops listening
 */
export function watchAppLifecycle({ pause, resume }, app = App, native = isNative()) {
	if (!native) return () => undefined;
	const listening = [app.addListener('pause', pause), app.addListener('resume', resume)];
	for (const handle of listening) handle.catch((/** @type {unknown} */ error) => console.error('Could not listen for app lifecycle events.', error));
	return () => {
		for (const handle of listening) handle.then((listener) => listener.remove()).catch(() => undefined);
	};
}
