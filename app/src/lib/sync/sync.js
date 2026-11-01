/**
 * The state behind the commit and sync controls for one repository: what changed,
 * how it stands against the remote, any open merge, and a push waiting for the
 * network. It calls the engine and reports failures in `report`, so its methods
 * resolve rather than reject and the screen has one place to show them.
 *
 * Pull and push run one at a time, in order. Local work (commits, discards,
 * resolving conflicts) does not wait for them, so a stalled connection never
 * holds up a commit; the engine's own locks keep the two apart.
 *
 * Nothing here merges or force-pushes on its own: a conflict opens the merge and
 * stays open until the user resolves or abandons it.
 */

import { writable } from 'svelte/store';
import { ErrorCode, GitEngineError } from '../git/errors.js';
import { syncRecordKey } from '../git/local-repos.js';

/** @typedef {import('../git/repo.js').Repo} Repo */
/** @typedef {import('../git/repo.js').Author} Author */

/**
 * @typedef {object} SyncReport
 * @property {string} code an `ErrorCode`, or `offline`
 * @property {string} message a sentence for the user
 */

/**
 * @typedef {object} SyncState
 * @property {boolean} loaded the first read finished
 * @property {boolean} online
 * @property {import('../git/repo.js').FileChange[]} files uncommitted changes
 * @property {import('../git/merge.js').MergeState | null} merge the open merge
 * @property {import('../git/merge.js').ConflictProgress[]} conflicts where each of its conflicts stands
 * @property {boolean} mergeDamaged the merge record cannot be read, so nothing works until it is reset
 * @property {string} branch
 * @property {number} ahead commits only on this device
 * @property {number} behind commits only on the remote, as of the last fetch
 * @property {boolean} hasRemote the remote branch is known
 * @property {string | null} lastSyncAt ISO time of the last pull or push that worked
 * @property {boolean} pushPending a push is waiting for the network
 * @property {'pull' | 'push' | null} syncing
 * @property {boolean} pullHeldBack local changes stopped a pull, and the user has to commit or discard them
 * @property {boolean} needsAuthor a merge or commit needs an author nobody has set
 * @property {SyncReport | null} report the last failure
 * @property {import('../git/limits.js').SizeFinding[]} commitWarnings size warnings from the last commit or merge commit
 */

/**
 * How long to wait before each retry of a push that could not reach the host while
 * the device reports a network, which no `online` event will announce the end of.
 * The last delay repeats.
 */
export const PUSH_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

/**
 * A failed network call that is worth repeating when the connection returns.
 * @param {unknown} error
 * @returns {boolean}
 */
const isConnectionFailure = (error) => error instanceof GitEngineError && (error.code === ErrorCode.NETWORK || error.code === ErrorCode.HOST_UNREACHABLE);

/**
 * @param {unknown} error
 * @returns {boolean} the merge record cannot be read
 */
const isMergeDamage = (error) => error instanceof GitEngineError && error.code === ErrorCode.MERGE_STATE_DAMAGED;

/**
 * @param {unknown} error
 * @returns {boolean} an open merge stands in the way, and closing it clears the way
 */
const isMergeRefusal = (error) => isMergeDamage(error) || (error instanceof GitEngineError && error.code === ErrorCode.MERGE_IN_PROGRESS);

/**
 * @param {unknown} error
 * @returns {SyncReport}
 */
const toReport = (error) => ({
	code: error instanceof GitEngineError ? error.code : ErrorCode.UNKNOWN,
	message: error instanceof Error ? error.message : 'Something went wrong.'
});

/**
 * @param {string[]} paths
 * @returns {string} a commit subject naming the first few paths
 */
export function commitMessageFor(paths) {
	const shown = paths.slice(0, 3).join(', ');
	return paths.length > 3 ? `Update ${shown} and ${paths.length - 3} more` : `Update ${shown}`;
}

// The store's methods are inferred; `Sync` below names them.
// eslint-disable-next-line jsdoc/require-returns
/**
 * @param {object} options
 * @param {string} options.repoId
 * @param {Pick<Repo, 'status' | 'aheadBehind' | 'describeConflicts' | 'pull' | 'fetchRemote' | 'push' | 'checkCommit' | 'pathsWithMarkers' | 'commit' | 'discardChanges' | 'resolveConflict' | 'completeMerge' | 'abortMerge' | 'undoUnpushedCommits' | 'resetDamagedMerge'>} options.repo
 * @param {{ refresh: () => Promise<void>, saveDrafts: () => Promise<{ saved: string[], skipped: string[] }> }} options.notes told when files changed underneath it
 * @param {() => Author | null} options.getAuthor
 * @param {Storage} [options.storage]
 * @param {() => boolean} [options.isOnline]
 * @param {() => boolean} [options.isVisible] a hidden page leaves retrying to its return
 * @param {() => Promise<unknown>} [options.sendQueuedPush] how a retry sends the queued push, when something else owns it
 * @param {number[]} [options.pushRetryDelaysMs]
 * @param {() => Date} [options.now]
 */
export function createSync({
	repoId,
	repo,
	notes,
	getAuthor,
	storage = globalThis.localStorage,
	isOnline = () => globalThis.navigator?.onLine !== false,
	isVisible = () => globalThis.document?.visibilityState !== 'hidden',
	sendQueuedPush,
	pushRetryDelaysMs = PUSH_RETRY_DELAYS_MS,
	now = () => new Date()
}) {
	const record = readRecord(storage, repoId);

	/** @type {SyncState} */
	let state = {
		loaded: false,
		online: isOnline(),
		files: [],
		merge: null,
		conflicts: [],
		mergeDamaged: false,
		branch: '',
		ahead: 0,
		behind: 0,
		hasRemote: false,
		lastSyncAt: record.lastSyncAt,
		pushPending: record.pushPending,
		syncing: null,
		pullHeldBack: false,
		needsAuthor: false,
		report: null,
		commitWarnings: []
	};
	const store = writable(state);

	/** @param {Partial<SyncState>} change */
	const set = (change) => {
		state = { ...state, ...change };
		store.set(state);
		if ('lastSyncAt' in change || 'pushPending' in change) {
			writeRecord(storage, repoId, { lastSyncAt: state.lastSyncAt, pushPending: state.pushPending });
		}
		if (!state.pushPending) cancelPushRetry();
	};

	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let retryTimer;
	let retries = 0;
	let stopped = false;

	const cancelPushRetry = () => {
		clearTimeout(retryTimer);
		retryTimer = undefined;
		retries = 0;
	};

	/**
	 * Tries a queued push again later, as long as that could help. Offline, hidden
	 * and an open merge each have an event of their own that sends it.
	 * @returns {void}
	 */
	const schedulePushRetry = () => {
		if (stopped || retryTimer !== undefined || !state.pushPending || state.merge || state.mergeDamaged || !isOnline() || !isVisible()) return;
		const delay = pushRetryDelaysMs[Math.min(retries, pushRetryDelaysMs.length - 1)];
		retries += 1;
		retryTimer = setTimeout(async () => {
			retryTimer = undefined;
			try {
				if (isOnline() && isVisible()) await (sendQueuedPush ?? pushIfPending)();
			} catch (error) {
				set({ report: toReport(error) });
			}
			schedulePushRetry();
		}, delay);
	};

	/** @returns {Promise<void>} */
	const readEngine = async () => {
		try {
			const { files, merge } = await repo.status();
			const [counts, conflicts] = await Promise.allSettled([repo.aheadBehind(), merge ? repo.describeConflicts() : []]);
			const failed = [counts, conflicts].find((result) => result.status === 'rejected');
			if (failed && isMergeDamage(failed.reason)) throw failed.reason;
			// An open merge refuses commit, pull and push, so its way out has to show
			// even when these details cannot be read. Every file then counts as open.
			set({
				loaded: true,
				mergeDamaged: false,
				files,
				merge,
				conflicts: conflicts.status === 'fulfilled' ? conflicts.value : (merge?.conflicts ?? []).map((conflict) => ({ ...conflict, hasMarkers: true, undecided: true })),
				...(counts.status === 'fulfilled' ? counts.value : {}),
				pullHeldBack: state.pullHeldBack && files.length > 0,
				...(failed ? { report: toReport(failed.reason) } : {})
			});
		} catch (error) {
			if (isMergeDamage(error)) set({ loaded: true, mergeDamaged: true, merge: null, conflicts: [], report: toReport(error) });
			else set({ loaded: true, report: toReport(error) });
		}
	};

	/** @type {Promise<void> | null} */
	let reading = null;
	/** @type {Promise<void> | null} */
	let nextRead = null;

	/**
	 * Rereads the engine; a failure lands in `report`. Every read waits its turn on
	 * the repo lock, ahead of whatever the user is saving, so requests made during
	 * a read share one more read after it, which still sees everything before them.
	 * @returns {Promise<void>}
	 */
	const refresh = () => {
		if (!reading) {
			reading = readEngine().finally(() => {
				reading = null;
			});
			return reading;
		}
		nextRead ??= reading.then(() => {
			nextRead = null;
			return refresh();
		});
		return nextRead;
	};

	/**
	 * @returns {Promise<void>} once the file list and open note match the disk
	 */
	const refreshFiles = () => notes.refresh().catch((/** @type {unknown} */ error) => set({ report: toReport(error) }));

	/** @type {Promise<unknown>} */
	let networkTail = Promise.resolve();

	/**
	 * Runs one pull or push after any that came before it.
	 * @template T
	 * @param {'pull' | 'push'} kind
	 * @param {() => Promise<T>} operation
	 * @returns {Promise<T>}
	 */
	const inTurn = (kind, operation) => {
		const run = networkTail.then(async () => {
			set({ syncing: kind });
			try {
				return await operation();
			} finally {
				set({ syncing: null });
			}
		});
		networkTail = run.catch(() => undefined);
		return run;
	};

	/**
	 * @param {boolean} quiet nothing to report when it cannot run, because the user did not ask
	 * @returns {Promise<{ ok: boolean, status?: string, code?: string }>} `status` is the engine's on success
	 */
	const pull = (quiet = false) =>
		inTurn('pull', async () => {
			if (!isOnline()) {
				if (!quiet) set({ report: { code: 'offline', message: 'You are offline, so nothing can be pulled right now.' } });
				return { ok: false, code: 'offline' };
			}
			const author = getAuthor();
			try {
				const result = await repo.pull({ author });
				// A conflict has integrated nothing yet; the merge commit and its push do that.
				set({ report: null, needsAuthor: !author && state.needsAuthor, pullHeldBack: false, ...(result.status === 'conflict' ? {} : { lastSyncAt: now().toISOString() }) });
				await refreshFiles();
				await refresh();
				return { ok: true, status: result.status };
			} catch (error) {
				if (error instanceof GitEngineError && error.code === ErrorCode.DIRTY_TREE) {
					set({ pullHeldBack: true });
					// Only the counts depend on this, so a failure here changes nothing.
					await repo.fetchRemote().catch(() => undefined);
				} else if (!author && error instanceof GitEngineError && error.code === ErrorCode.INVALID_ARGUMENT) {
					set({ needsAuthor: true });
				} else if (!(quiet && isConnectionFailure(error))) {
					set({ report: toReport(error) });
				}
				await refresh();
				if (isConnectionFailure(error)) schedulePushRetry();
				return { ok: false, code: error instanceof GitEngineError ? error.code : ErrorCode.UNKNOWN };
			}
		});

	/**
	 * Pushes, or queues the push when the network is what stands in the way.
	 * @returns {Promise<{ ok: boolean, queued: boolean, code?: string }>}
	 */
	const push = () =>
		inTurn('push', async () => {
			if (!isOnline()) {
				set({ pushPending: true });
				return { ok: false, queued: true, code: 'offline' };
			}
			try {
				const result = await repo.push();
				set({ pushPending: false, report: null, ...(result.pushed ? { lastSyncAt: now().toISOString() } : {}) });
				await refresh();
				return { ok: true, queued: false };
			} catch (error) {
				const queued = isConnectionFailure(error);
				// An open merge only delays a push asked for earlier; the merge's end sends it.
				set({ pushPending: queued || (state.pushPending && isMergeRefusal(error)), report: toReport(error) });
				await refresh();
				if (queued) schedulePushRetry();
				return { ok: false, queued, code: error instanceof GitEngineError ? error.code : ErrorCode.UNKNOWN };
			}
		});

	/**
	 * @param {object} options
	 * @param {string[]} options.paths
	 * @param {string} options.message
	 * @returns {Promise<{ ok: boolean, code?: string, warnings?: import('../git/limits.js').SizeFinding[] }>}
	 */
	const commit = async ({ paths, message }) => {
		const author = getAuthor();
		if (!author) {
			set({ needsAuthor: true });
			return { ok: false, code: ErrorCode.INVALID_ARGUMENT };
		}
		try {
			const { warnings } = await repo.commit({ paths, message, author });
			set({ report: null, needsAuthor: false, commitWarnings: warnings });
			await refresh();
			return { ok: true, warnings };
		} catch (error) {
			const code = error instanceof GitEngineError ? error.code : ErrorCode.UNKNOWN;
			// Another tab got there first, which is no failure of anyone's.
			if (code !== ErrorCode.NOTHING_TO_COMMIT) set({ report: toReport(error) });
			await refresh();
			return { ok: false, code };
		}
	};

	/**
	 * Runs an engine call that changes files, then rereads everything.
	 * @template T
	 * @param {() => Promise<T>} operation
	 * @returns {Promise<{ ok: boolean, value?: T }>}
	 */
	const changingFiles = async (operation) => {
		try {
			const value = await operation();
			set({ report: null });
			await refreshFiles();
			await refresh();
			return { ok: true, value };
		} catch (error) {
			set({ report: toReport(error) });
			await refresh();
			return { ok: false };
		}
	};

	const saveDrafts = async () => {
		try {
			const result = await notes.saveDrafts();
			await refresh();
			return result;
		} catch (error) {
			set({ report: toReport(error) });
			return { saved: [], skipped: [] };
		}
	};

	/**
	 * Sends a queued push if the network allows one. An open merge holds it, and
	 * completing the merge sends it.
	 * @returns {Promise<void>}
	 */
	const pushIfPending = async () => {
		if (!state.pushPending || !isOnline()) return;
		// Another tab may have opened or closed a merge since the last read.
		await refresh();
		if (state.merge || state.mergeDamaged) return;
		await push();
	};

	/**
	 * Runs an engine call that closes a merge. A push the merge was holding goes
	 * now, and if the host refuses it the report offers a pull.
	 * @param {() => Promise<unknown>} operation
	 * @returns {Promise<{ ok: boolean }>}
	 */
	const closingMerge = async (operation) => {
		const result = await changingFiles(operation);
		if (result.ok) await pushIfPending();
		return result;
	};

	return {
		subscribe: store.subscribe,
		refresh,
		pull,
		push,
		commit,

		/**
		 * What a screen does on opening a repository: read the state, push what was
		 * queued, and pull when online. An open merge is shown, never pulled over.
		 * @returns {Promise<void>}
		 */
		async open() {
			await refresh();
			if (state.mergeDamaged || state.merge) return;
			await pull(true);
			if (state.merge) return;
			if (state.pushPending) await push();
		},

		/**
		 * @param {boolean} online
		 * @returns {void}
		 */
		setOnline(online) {
			if (online !== state.online) set({ online });
		},

		pushIfPending,

		/**
		 * Saves every note's unsaved text and rereads the changes.
		 * @returns {Promise<{ saved: string[], skipped: string[] }>}
		 */
		saveDrafts,

		/** @type {import('./autosave.js').AutosaveOps} */
		autosaveOps: {
			saveDrafts,
			readWork: async () => {
				await refresh();
				return { merge: state.merge !== null || state.mergeDamaged, paths: state.files.map((file) => file.path), ahead: state.ahead, pushPending: state.pushPending };
			},
			checkCommit: (paths) => repo.checkCommit(paths),
			findMarkers: (paths) => repo.pathsWithMarkers(paths),
			commit: (paths, message) => commit({ paths, message }),
			pull: () => pull(),
			push,
			queuePush: () => set({ pushPending: true })
		},

		/**
		 * @param {unknown} error
		 * @returns {void}
		 */
		reportFailure(error) {
			set({ report: toReport(error) });
		},

		/**
		 * @param {string[]} paths
		 * @returns {Promise<{ ok: boolean }>}
		 */
		discard: (paths) => changingFiles(() => repo.discardChanges(paths)),

		/**
		 * @param {string} path
		 * @param {'ours' | 'theirs'} side
		 * @returns {Promise<{ ok: boolean }>}
		 */
		resolve: (path, side) => changingFiles(() => repo.resolveConflict({ path, side })),

		/**
		 * Makes the merge commit, then sends a push that waited for it.
		 * @param {{ allowMarkers: boolean }} options
		 * @returns {Promise<{ ok: boolean }>}
		 */
		async completeMerge({ allowMarkers }) {
			const author = getAuthor();
			if (!author) {
				set({ needsAuthor: true });
				return { ok: false };
			}
			const result = await changingFiles(() => repo.completeMerge({ author, allowMarkers }));
			if (result.value) {
				set({ commitWarnings: result.value.warnings });
				await pushIfPending();
			}
			return result;
		},

		/** @returns {Promise<{ ok: boolean }>} */
		abortMerge: () => closingMerge(() => repo.abortMerge()),

		/** @returns {Promise<{ ok: boolean }>} */
		undoUnpushed: () => changingFiles(() => repo.undoUnpushedCommits()),

		/** @returns {Promise<{ ok: boolean }>} */
		resetDamagedMerge: () => closingMerge(() => repo.resetDamagedMerge()),

		/**
		 * The screen is going away: no more retries from this instance.
		 * @returns {void}
		 */
		stop() {
			stopped = true;
			cancelPushRetry();
		}
	};
}

/** @typedef {ReturnType<typeof createSync>} Sync */

/**
 * @param {Storage} storage
 * @param {string} repoId
 * @returns {{ lastSyncAt: string | null, pushPending: boolean }}
 */
function readRecord(storage, repoId) {
	/** @type {{ lastSyncAt?: unknown, pushPending?: unknown } | null} */
	let value = null;
	try {
		value = JSON.parse(storage.getItem(syncRecordKey(repoId)) ?? 'null');
	} catch {
		// An unreadable record only forgets a time and a queued push.
	}
	return {
		lastSyncAt: typeof value?.lastSyncAt === 'string' ? value.lastSyncAt : null,
		pushPending: value?.pushPending === true
	};
}

/**
 * @param {Storage} storage
 * @param {string} repoId
 * @param {{ lastSyncAt: string | null, pushPending: boolean }} value
 * @returns {void}
 */
function writeRecord(storage, repoId, value) {
	try {
		storage.setItem(syncRecordKey(repoId), JSON.stringify(value));
	} catch {
		// Refused storage costs the record only: the commits stay, and show as unpushed.
	}
}
