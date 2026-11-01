import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_TYPES } from './static-server.js';

/**
 * Runs the Android build in Chromium as the WebView would, for everything short of
 * Android itself. Its files come from `https://localhost` under Capacitor's rules,
 * with the real `native-bridge.js` added to `<head>` as a nonce-less inline script,
 * which is how Capacitor injects it where document-start scripts are unavailable.
 * Only the Java side of the plugins is stood in for, at the bridge's own protocol.
 */

/** Where the browser tests put the Android build, under `app/`. It is never deployed. */
export const NATIVE_BUILD_DIR = 'build-native-e2e';

/** The WebView's origin; also the first thing the relay's allowlist must name. */
export const NATIVE_ORIGIN = 'https://localhost';

const BUILD_ROOT = fileURLToPath(new URL(`../${NATIVE_BUILD_DIR}/`, import.meta.url));

/** The methods each plugin's Java class exports, as its generated header lists them. */
const PLUGIN_HEADERS = [
	{ name: 'App', methods: ['getLaunchUrl', 'removeAllListeners'] },
	{ name: 'Browser', methods: ['open', 'close', 'removeAllListeners'] },
	{ name: 'SecureStorage', methods: ['internalGetItem', 'internalSetItem', 'internalRemoveItem'] }
].map(({ name, methods }) => ({
	name,
	methods: [...methods.map((method) => ({ name: method, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }]
}));

/**
 * @returns {Promise<string>} what Capacitor puts at the top of `<head>`
 */
async function bridgeScript() {
	const androidPackage = createRequire(import.meta.url).resolve('@capacitor/android/package.json');
	const bridge = await readFile(path.join(path.dirname(androidPackage), 'capacitor/src/main/assets/native-bridge.js'), 'utf8');
	return `<script type="text/javascript">
window.Capacitor = { DEBUG: false, isLoggingEnabled: false, Plugins: {} };
${bridge}
window.Capacitor.PluginHeaders = ${JSON.stringify(PLUGIN_HEADERS)};
</script>`;
}

/** @typedef {{ url: string, eventName: string, callbackId: string, prefixedKey: string, data: string }} NativeOptions */

/**
 * @typedef {object} NativeCall
 * @property {string} pluginId
 * @property {string} methodName
 * @property {NativeOptions} options
 */

// The device's parts are inferred.
// eslint-disable-next-line jsdoc/require-returns
/**
 * Turns a page into the app on a device.
 * @param {import('@playwright/test').Page} page
 */
export async function installNativeShell(page) {
	const bridge = await bridgeScript();
	/** @type {NativeCall[]} */
	const calls = [];
	/**
	 * What the Android Keystore-backed plugin holds.
	 * @type {Map<string, string>}
	 */
	const secure = new Map();
	/** @type {{ launchUrl: string | null }} */
	const device = { launchUrl: null };
	/** @type {{ callbackId: string, pluginId: string, eventName: string }[]} */
	let listeners = [];

	/** @type {Record<string, (options: NativeOptions) => unknown>} */
	const methods = {
		'App.getLaunchUrl': () => (device.launchUrl === null ? {} : { url: device.launchUrl }),
		'Browser.open': () => ({}),
		'Browser.close': () => ({}),
		'SecureStorage.internalGetItem': ({ prefixedKey }) => ({ data: secure.get(prefixedKey) ?? null }),
		'SecureStorage.internalSetItem': ({ prefixedKey, data }) => {
			secure.set(prefixedKey, data);
			return {};
		},
		'SecureStorage.internalRemoveItem': ({ prefixedKey }) => ({ success: secure.delete(prefixedKey) })
	};

	/**
	 * @param {Record<string, unknown>} result
	 * @returns {Promise<void>}
	 */
	const toPage = (result) => page.evaluate((message) => Reflect.get(globalThis, 'Capacitor').fromNative(message), result);

	await page.exposeBinding('gitnoteNativeBridge', async (_source, /** @type {string} */ text) => {
		const { callbackId, pluginId, methodName, options } = JSON.parse(text);
		calls.push({ pluginId, methodName, options });
		if (methodName === 'addListener') {
			listeners.push({ callbackId, pluginId, eventName: options.eventName });
			return;
		}
		if (methodName === 'removeListener') {
			listeners = listeners.filter((listener) => listener.callbackId !== options.callbackId);
			await toPage({ callbackId, pluginId, methodName, success: true, data: {} });
			return;
		}
		const method = methods[`${pluginId}.${methodName}`];
		await toPage(method ? { callbackId, pluginId, methodName, success: true, data: method(options) } : { callbackId, pluginId, methodName, success: false, error: { message: `${pluginId}.${methodName} is not implemented` } });
	});

	await page.addInitScript(() => {
		const native = Reflect.get(globalThis, 'gitnoteNativeBridge');
		Object.assign(globalThis, {
			androidBridge: { postMessage: (/** @type {string} */ text) => native(text) },
			CapacitorCookiesAndroidInterface: { isEnabled: () => false },
			CapacitorHttpAndroidInterface: { isEnabled: () => false }
		});
	});

	// `WebViewLocalServer`: a last segment with no dot gets the app, with the bridge
	// added; anything else must be a real asset.
	await page.route(`${NATIVE_ORIGIN}/**`, async (route) => {
		const { pathname } = new URL(route.request().url());
		const last = pathname.split('/').pop() ?? '';
		if (!last.includes('.')) {
			const html = await readFile(path.join(BUILD_ROOT, 'index.html'), 'utf8');
			await route.fulfill({ status: 200, contentType: CONTENT_TYPES['.html'], body: html.replace('<head>', `<head>\n${bridge}\n`) });
			return;
		}
		try {
			await route.fulfill({ status: 200, contentType: CONTENT_TYPES[path.extname(last)] ?? 'application/octet-stream', body: await readFile(path.join(BUILD_ROOT, decodeURIComponent(pathname))) });
		} catch {
			await route.fulfill({ status: 404, body: '' });
		}
	});

	return {
		calls,
		secure,
		device,
		/**
		 * Fires an App plugin event at whatever is listening.
		 * @param {string} eventName
		 * @param {Record<string, unknown>} [data]
		 * @returns {Promise<void>}
		 */
		async fire(eventName, data = {}) {
			for (const { callbackId, pluginId } of listeners.filter((listener) => listener.pluginId === 'App' && listener.eventName === eventName)) {
				await toPage({ callbackId, pluginId, methodName: 'addListener', success: true, save: true, data });
			}
		},
		/**
		 * @param {string} eventName
		 * @returns {boolean} an App plugin listener for it is registered
		 */
		isListening: (eventName) => listeners.some((listener) => listener.pluginId === 'App' && listener.eventName === eventName),
		/**
		 * @returns {string | undefined} the URL last opened in the Custom Tab
		 */
		openedInTab: () => calls.findLast((call) => call.pluginId === 'Browser' && call.methodName === 'open')?.options.url,
		/**
		 * @returns {number} how often the app closed the Custom Tab
		 */
		tabCloses: () => calls.filter((call) => call.pluginId === 'Browser' && call.methodName === 'close').length
	};
}
