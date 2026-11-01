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
 * @property {boolean} needsAuthor a pull or commit needs an author nobody has set
 * @property {SyncReport | null} report the last failure
 */

/**
 * A failed network call that is worth repeating when the connection returns.
 * @param {unknown} error
 * @returns {boolean}
 */
const isConnectionFailure = (error) => error instanceof GitEngineError && (error.code === ErrorCode.NETWORK || error.code === ErrorCode.HOST_UNREACHABLE);

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
 * @param {Pick<Repo, 'status' | 'aheadBehind' | 'describeConflicts' | 'pull' | 'fetchRemote' | 'push' | 'commit' | 'discardChanges' | 'resolveConflict' | 'completeMerge' | 'abortMerge' | 'undoUnpushedCommits' | 'resetDamagedMerge'>} options.repo
 * @param {{ refresh: () => Promise<void>, saveDrafts: () => Promise<{ saved: string[], skipped: string[] }> }} options.notes told when files changed underneath it
 * @param {() => Author | null} options.getAuthor
 * @param {Storage} [options.storage]
 * @param {() => boolean} [options.isOnline]
 * @param {() => Date} [options.now]
 */
export function createSync({ repoId, repo, notes, getAuthor, storage = globalThis.localStorage, isOnline = () => globalThis.navigator?.onLine !== false, now = () => new Date() }) {
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
		report: null
	};
	const store = writable(state);

	/** @param {Partial<SyncState>} change */
	const set = (change) => {
		state = { ...state, ...change };
		store.set(state);
		if ('lastSyncAt' in change || 'pushPending' in change) {
			writeRecord(storage, repoId, { lastSyncAt: state.lastSyncAt, pushPending: state.pushPending });
		}
	};

	/** @returns {Promise<void>} */
	const readEngine = async () => {
		try {
			const { files, merge } = await repo.status();
			const [counts, conflicts] = await Promise.all([repo.aheadBehind(), merge ? repo.describeConflicts() : []]);
			set({ loaded: true, mergeDamaged: false, files, merge, conflicts, ...counts, pullHeldBack: state.pullHeldBack && files.length > 0 });
		} catch (error) {
			if (error instanceof GitEngineError && error.code === ErrorCode.MERGE_STATE_DAMAGED) set({ loaded: true, mergeDamaged: true, merge: null, conflicts: [], report: toReport(error) });
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
			if (!author) {
				set({ needsAuthor: true });
				return { ok: false, code: ErrorCode.INVALID_ARGUMENT };
			}
			try {
				const result = await repo.pull({ author });
				set({ report: null, needsAuthor: false, pullHeldBack: false, lastSyncAt: now().toISOString() });
				await refreshFiles();
				await refresh();
				return { ok: true, status: result.status };
			} catch (error) {
				if (error instanceof GitEngineError && error.code === ErrorCode.DIRTY_TREE) {
					set({ pullHeldBack: true });
					// Only the counts depend on this, so a failure here changes nothing.
					await repo.fetchRemote().catch(() => undefined);
				} else if (!(quiet && isConnectionFailure(error))) {
					set({ report: toReport(error) });
				}
				await refresh();
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
				set({ pushPending: queued, report: toReport(error) });
				await refresh();
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
			set({ report: null, needsAuthor: false });
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

		/** @returns {Promise<void>} once a queued push has run, if the network allows one */
		async pushIfPending() {
			if (state.pushPending && isOnline()) await push();
		},

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
				return { merge: state.merge !== null || state.mergeDamaged, paths: state.files.map((file) => file.path), ahead: state.ahead };
			},
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
		 * @param {{ allowMarkers: boolean }} options
		 * @returns {Promise<{ ok: boolean }>}
		 */
		async completeMerge({ allowMarkers }) {
			const author = getAuthor();
			if (!author) {
				set({ needsAuthor: true });
				return { ok: false };
			}
			return changingFiles(() => repo.completeMerge({ author, allowMarkers }));
		},

		/** @returns {Promise<{ ok: boolean }>} */
		abortMerge: () => changingFiles(() => repo.abortMerge()),

		/** @returns {Promise<{ ok: boolean }>} */
		undoUnpushed: () => changingFiles(() => repo.undoUnpushedCommits()),

		/** @returns {Promise<{ ok: boolean }>} */
		resetDamagedMerge: () => changingFiles(() => repo.resetDamagedMerge())
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
