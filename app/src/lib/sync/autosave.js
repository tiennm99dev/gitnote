/**
 * The autosave beta: commits and pushes on a timer while the page is visible.
 *
 * Timers run reliably only in the foreground, and a backgrounded Android app is
 * frozen seconds after it leaves. So going hidden commits locally and goes no
 * further, and coming back, launching or regaining the network does the push.
 *
 * It never commits while a merge is open and never resolves a conflict: a pull
 * that conflicts leaves the merge open for the user, and every later run stands
 * aside until it is closed. The timer keeps ticking through that, so autosave
 * picks up again by itself once the merge is done.
 */

import { writable } from 'svelte/store';
import { ErrorCode } from '../git/errors.js';

const MINUTE_MS = 60_000;

/** Keeps a commit subject readable when many files changed. */
const MAX_PATHS_IN_MESSAGE = 5;

/**
 * @param {string[]} paths
 * @returns {string} the commit message for an autosave
 */
export function autosaveMessage(paths) {
	const shown = paths.slice(0, MAX_PATHS_IN_MESSAGE).join(', ');
	return paths.length > MAX_PATHS_IN_MESSAGE ? `autosave: ${shown} and ${paths.length - MAX_PATHS_IN_MESSAGE} more` : `autosave: ${shown}`;
}

/**
 * What autosave needs from the app.
 * @typedef {object} AutosaveOps
 * @property {() => Promise<{ saved: string[], skipped: string[] }>} saveDrafts
 * @property {() => Promise<{ merge: boolean, paths: string[], ahead: number }>} readWork
 * @property {(paths: string[], message: string) => Promise<{ ok: boolean }>} commit
 * @property {() => Promise<{ ok: boolean, status?: string, code?: string }>} pull
 * @property {() => Promise<{ ok: boolean }>} push
 * @property {() => void} queuePush
 */

/**
 * @typedef {object} AutosaveState
 * @property {boolean} enabled
 * @property {string[]} skipped notes left out because their file changed underneath them
 */

// The scheduler's methods are inferred; `Autosave` below names them.
// eslint-disable-next-line jsdoc/require-returns
/**
 * @param {object} options
 * @param {AutosaveOps} options.ops
 * @param {() => boolean} options.isVisible
 * @param {() => boolean} options.isOnline
 * @param {(error: unknown) => void} options.onError
 */
export function createAutosave({ ops, isVisible, isOnline, onError }) {
	/** @type {AutosaveState} */
	let state = { enabled: false, skipped: [] };
	const store = writable(state);

	/** @param {Partial<AutosaveState>} change */
	const set = (change) => {
		state = { ...state, ...change };
		store.set(state);
	};

	let intervalMs = 5 * MINUTE_MS;
	/** @type {ReturnType<typeof setInterval> | undefined} */
	let timer;
	/**
	 * Commits run one at a time; a run that finds nothing left to do is harmless.
	 * @type {Promise<unknown>}
	 */
	let commitTail = Promise.resolve();
	let uploading = false;

	/**
	 * Saves unsaved text and commits whatever changed.
	 * @returns {Promise<{ blocked: boolean, ahead: number }>}
	 */
	const commitChanges = async () => {
		const before = await ops.readWork();
		if (before.merge) return { blocked: true, ahead: before.ahead };
		const { skipped } = await ops.saveDrafts();
		set({ skipped });
		const work = await ops.readWork();
		if (work.merge) return { blocked: true, ahead: work.ahead };
		if (work.paths.length === 0) return { blocked: false, ahead: work.ahead };
		const committed = await ops.commit(work.paths, autosaveMessage(work.paths));
		return { blocked: false, ahead: work.ahead + (committed.ok ? 1 : 0) };
	};

	/**
	 * @returns {Promise<{ blocked: boolean, ahead: number }>}
	 */
	const commitInTurn = () => {
		const run = commitTail.then(commitChanges, commitChanges);
		commitTail = run.catch(() => undefined);
		return run;
	};

	/**
	 * Pulls, then pushes. A conflict stops here with the merge open; local changes
	 * holding the pull back do not, because the host refuses a push that would
	 * overwrite anything, and the next run commits them.
	 * @returns {Promise<void>}
	 */
	const upload = async () => {
		if (uploading) return;
		uploading = true;
		try {
			if (!isOnline()) {
				ops.queuePush();
				return;
			}
			const pulled = await ops.pull();
			if (pulled.status === 'conflict') return;
			if (!pulled.ok && pulled.code !== ErrorCode.DIRTY_TREE) return;
			await ops.push();
		} finally {
			uploading = false;
		}
	};

	const tick = async () => {
		const { blocked, ahead } = await commitInTurn();
		if (!blocked && ahead > 0) await upload();
	};

	/**
	 * Timers and page events have nobody to hand a failure to.
	 * @param {() => Promise<unknown>} run
	 * @returns {Promise<void>}
	 */
	const guarded = async (run) => {
		try {
			await run();
		} catch (error) {
			onError(error);
		}
	};

	/** Coming back, launching and reconnecting push what is there; none of them commits. */
	const pushWhatIsThere = async () => {
		const work = await ops.readWork();
		if (!work.merge && work.ahead > 0) await upload();
	};

	const stopTimer = () => {
		clearInterval(timer);
		timer = undefined;
	};

	const startTimer = () => {
		stopTimer();
		if (state.enabled && isVisible()) {
			timer = setInterval(() => {
				void guarded(tick);
			}, intervalMs);
		}
	};

	return {
		subscribe: store.subscribe,

		/**
		 * Applies the settings; turning it on counts as a launch.
		 * @param {{ enabled: boolean, intervalMinutes: number }} options
		 * @returns {Promise<void>}
		 */
		async configure({ enabled, intervalMinutes }) {
			const started = enabled && !state.enabled;
			const nextInterval = intervalMinutes * MINUTE_MS;
			const changed = enabled !== state.enabled || nextInterval !== intervalMs;
			intervalMs = nextInterval;
			set({ enabled });
			if (changed) startTimer();
			if (started) await guarded(pushWhatIsThere);
		},

		/**
		 * The page went to the background: commit locally, and touch no network.
		 * @returns {Promise<void>}
		 */
		async handleHidden() {
			stopTimer();
			if (state.enabled) await guarded(commitInTurn);
		},

		/**
		 * The page came back.
		 * @returns {Promise<void>}
		 */
		async handleVisible() {
			startTimer();
			if (state.enabled) await guarded(pushWhatIsThere);
		},

		/**
		 * The network came back.
		 * @returns {Promise<void>}
		 */
		async handleOnline() {
			if (state.enabled) await guarded(pushWhatIsThere);
		},

		/** @returns {void} */
		stop() {
			stopTimer();
		}
	};
}

/** @typedef {ReturnType<typeof createAutosave>} Autosave */
