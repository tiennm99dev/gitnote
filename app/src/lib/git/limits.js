/**
 * Provider-aware size limits, checked before any network call. The table is
 * data, so another provider is one more row.
 */

const MB = 1_000_000;
const MiB = 1024 * 1024;

/**
 * Largest request body the relay forwards (`MAX_BODY_BYTES` in the relay's
 * git proxy). Every push goes through the relay, so this caps a push pack on
 * every provider. A file above it can still be committed where the host's own
 * file limit is higher, but it cannot be pushed, and the commit warning says so.
 */
export const RELAY_MAX_BODY_BYTES = 95 * MB;

/** Above this size, warn before cloning: isomorphic-git is slow and memory-heavy on big repos. */
export const REPO_SIZE_WARN_BYTES = 300 * MB;

/**
 * @typedef {'github' | 'gitlab'} ProviderId
 */

/**
 * @typedef {object} ProviderLimits
 * @property {string} label the provider name shown in messages
 * @property {number} warnFileBytes a file above this warns
 * @property {number} blockFileBytes a file above this cannot be committed
 * @property {string} blockFileReason why the file block sits where it does
 * @property {number} blockPushBytes an estimated push pack above this is not sent
 */

/** @type {Readonly<Record<ProviderId, Readonly<ProviderLimits>>>} */
export const PROVIDER_LIMITS = Object.freeze({
	github: Object.freeze({
		label: 'GitHub',
		warnFileBytes: 50 * MB,
		// GitHub rejects any pushed file over 100 MiB (error GH001).
		blockFileBytes: 100 * MiB,
		blockFileReason: "GitHub's per-file limit",
		blockPushBytes: RELAY_MAX_BODY_BYTES
	}),
	gitlab: Object.freeze({
		label: 'GitLab',
		warnFileBytes: 50 * MB,
		// gitlab.com documents no per-file cap, so the relay's body cap is the limit.
		blockFileBytes: RELAY_MAX_BODY_BYTES,
		blockFileReason: "the relay's per-push limit",
		blockPushBytes: RELAY_MAX_BODY_BYTES
	})
});

/** Hosts whose limits are known, by URL hostname. */
const PROVIDER_HOSTS = /** @type {const} */ ({ 'github.com': 'github', 'gitlab.com': 'gitlab' });

/**
 * @param {string} provider
 * @returns {provider is ProviderId}
 */
export function isProviderId(provider) {
	return Object.hasOwn(PROVIDER_LIMITS, provider);
}

/**
 * @param {string} provider
 * @returns {Readonly<ProviderLimits>}
 */
export function limitsFor(provider) {
	if (!isProviderId(provider)) throw new TypeError(`Unknown git provider: ${provider}`);
	return PROVIDER_LIMITS[provider];
}

/**
 * @param {string} url a repository URL
 * @returns {ProviderId | null} the provider for a known host, or null
 */
export function providerForUrl(url) {
	/** @type {URL} */
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const host = /** @type {keyof typeof PROVIDER_HOSTS} */ (parsed.hostname.toLowerCase());
	return Object.hasOwn(PROVIDER_HOSTS, host) ? PROVIDER_HOSTS[host] : null;
}

/**
 * @param {number} bytes
 * @returns {string} a short human size, in decimal MB above 1 MB
 */
export function formatBytes(bytes) {
	if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
	if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB`;
	return `${bytes} B`;
}

/**
 * @typedef {object} SizeFinding
 * @property {'warn' | 'block'} level
 * @property {number} size bytes found
 * @property {number} limit the limit it crossed, in bytes
 * @property {string} message a sentence naming the limit
 * @property {string} [path] the file, for file findings
 */

/**
 * @param {string} provider
 * @param {string} path
 * @param {number} size file size in bytes
 * @returns {SizeFinding | null} a warning, a block, or null when the file is fine
 */
export function checkFileSize(provider, path, size) {
	const limits = limitsFor(provider);
	if (size > limits.blockFileBytes) {
		return {
			level: 'block',
			path,
			size,
			limit: limits.blockFileBytes,
			message: `${path} is ${formatBytes(size)}, over ${limits.blockFileReason} of ${formatBytes(limits.blockFileBytes)}. It cannot be committed.`
		};
	}
	if (size > limits.blockPushBytes) {
		return {
			level: 'warn',
			path,
			size,
			limit: limits.blockPushBytes,
			message: `${path} is ${formatBytes(size)}, over the relay's per-push limit of ${formatBytes(limits.blockPushBytes)}. It can be committed, but a commit holding it cannot be pushed through the relay.`
		};
	}
	if (size > limits.warnFileBytes) {
		return {
			level: 'warn',
			path,
			size,
			limit: limits.warnFileBytes,
			message: `${path} is ${formatBytes(size)}, over ${formatBytes(limits.warnFileBytes)}. ${limits.label} warns about files this large, and every clone downloads it.`
		};
	}
	return null;
}

/**
 * @param {string} provider
 * @param {number} bytes the estimated push pack size
 * @returns {SizeFinding | null} a block, or null when the push may go
 */
export function checkPushSize(provider, bytes) {
	const limits = limitsFor(provider);
	if (bytes <= limits.blockPushBytes) return null;
	return {
		level: 'block',
		size: bytes,
		limit: limits.blockPushBytes,
		message: `This push is about ${formatBytes(bytes)}, over the relay's per-push limit of ${formatBytes(limits.blockPushBytes)}. Undo the unpushed commits, then make smaller commits and push after each one.`
	};
}

/**
 * Push sends the whole branch, so what is already unpushed counts as well.
 * @param {string} provider
 * @param {number} bytes the unpushed commits' size plus the commit being made
 * @returns {SizeFinding | null} a warning that these commits cannot be pushed together
 */
export function checkUnpushedSize(provider, bytes) {
	const limits = limitsFor(provider);
	if (bytes <= limits.blockPushBytes) return null;
	return {
		level: 'warn',
		size: bytes,
		limit: limits.blockPushBytes,
		message: `With this commit, your unpushed commits come to about ${formatBytes(bytes)}, over the relay's per-push limit of ${formatBytes(limits.blockPushBytes)}. Push what you have first; otherwise you will need to undo the unpushed commits to push anything.`
	};
}

/**
 * @param {number} bytes the repository size reported by the provider
 * @returns {SizeFinding | null} a warning for a repo too large to clone comfortably
 */
export function checkRepoSize(bytes) {
	if (bytes <= REPO_SIZE_WARN_BYTES) return null;
	return {
		level: 'warn',
		size: bytes,
		limit: REPO_SIZE_WARN_BYTES,
		message: `This repository is about ${formatBytes(bytes)}. Repositories over ${formatBytes(REPO_SIZE_WARN_BYTES)} clone slowly and can run out of browser memory.`
	};
}
