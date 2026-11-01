<script>
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { AuthError, AuthErrorCode } from '#lib/auth/errors.js';
	import { authSession } from '#lib/auth/index.js';
	import { PROVIDERS } from '#lib/auth/providers.js';
	import { deleteDeviceRepo, describeDeviceWork, openDeviceRepo } from '#lib/git/device-repos.js';
	import { ErrorCode, GitEngineError } from '#lib/git/errors.js';
	import { getStorageUsage, repoIdForUrl } from '#lib/git/fs.js';
	import { checkRepoSize, formatBytes } from '#lib/git/limits.js';
	import { describeWorkCounts, listLocalRepos, saveLocalRepo, settleFailedClone } from '#lib/git/local-repos.js';

	/** @typedef {import('#lib/auth/session.js').RemoteRepo} RemoteRepo */
	/** @typedef {import('#lib/git/limits.js').ProviderId} ProviderId */

	/** @type {import('#lib/auth/session.js').Account[]} */
	let accounts = $state([]);
	let loaded = $state(false);
	/** @type {ProviderId | null} */
	let provider = $state(null);
	/** @type {import('#lib/auth/session.js').RepoList | null} */
	let list = $state(null);
	let search = $state('');
	/** @type {RemoteRepo | null} */
	let selected = $state(null);
	/** @type {string[]} */
	let branches = $state([]);
	let branch = $state('');
	/** @type {string | null} */
	let branchNotice = $state(null);
	/** @type {string | null} */
	let progress = $state(null);
	/** @type {string | null} */
	let failure = $state(null);
	let signInNeeded = $state(false);
	/** @type {string | null} */
	let storageWarning = $state(null);
	/** @type {{ repo: import('#lib/git/local-repos.js').LocalRepo, files: number | null | undefined }[]} */
	let copies = $state([]);
	/**
	 * The deletion being confirmed.
	 * @type {{ work: import('#lib/git/local-repos.js').LocalWork, changed: boolean } | null}
	 */
	let removing = $state(null);

	const account = $derived(accounts.find((item) => item.provider === provider));
	const shown = $derived.by(() => {
		const query = search.trim().toLowerCase();
		const repos = list?.repos ?? [];
		return query ? repos.filter((repo) => repo.fullName.toLowerCase().includes(query)) : repos;
	});
	const sizeWarning = $derived.by(() => {
		const size = /** @type {RemoteRepo | null} */ (selected)?.sizeBytes;
		return typeof size === 'number' ? checkRepoSize(size) : null;
	});
	const isOnDevice = $derived.by(() => {
		const repo = /** @type {RemoteRepo | null} */ (selected);
		if (!repo) return false;
		const id = repoIdForUrl(repo.url);
		return copies.some((copy) => copy.repo.ready && copy.repo.id === id);
	});

	/**
	 * @param {unknown} error
	 * @returns {void}
	 */
	const report = (error) => {
		signInNeeded = (error instanceof AuthError && error.code === AuthErrorCode.SIGN_IN_REQUIRED) || (error instanceof GitEngineError && error.code === ErrorCode.AUTH_REQUIRED);
		failure = error instanceof Error ? error.message : 'Something went wrong.';
	};

	const clearReport = () => {
		failure = null;
		signInNeeded = false;
	};

	/** Tells a later read of the copies from one still waiting on a lock. */
	let copiesRead = 0;

	/**
	 * Lists what is on this device, which works with no account and no network. The
	 * list shows at once and the counts follow, as they wait for whatever another
	 * tab is doing to the repo. `files` is undefined until then, null if unreadable.
	 */
	const loadCopies = async () => {
		copiesRead += 1;
		const read = copiesRead;
		const repos = listLocalRepos();
		copies = repos.map((repo) => ({ repo, files: undefined }));
		const counted = await Promise.all(
			repos.map(async (repo) => {
				if (!repo.ready) return { repo, files: null };
				try {
					return { repo, files: (await openDeviceRepo(repo).listTree()).length };
				} catch {
					return { repo, files: null };
				}
			})
		);
		if (read === copiesRead) copies = counted;
	};

	/**
	 * @param {import('#lib/git/local-repos.js').LocalRepo} repo
	 * @param {number | null | undefined} files
	 * @returns {string}
	 */
	const describeCopy = (repo, files) => {
		if (!repo.ready) return ', clone not finished';
		if (files === undefined) return '';
		if (files === null) return ', could not be read';
		return `, ${files} ${files === 1 ? 'file' : 'files'}`;
	};

	/** @param {ProviderId} id */
	const loadRepos = async (id) => {
		provider = id;
		list = null;
		selected = null;
		clearReport();
		// The page already asks for a new sign-in, and asking the provider cannot help.
		if (accounts.find((item) => item.provider === id)?.needsSignIn) return;
		try {
			const answer = await authSession.listRepos(id);
			if (provider === id) list = answer;
		} catch (error) {
			if (provider === id) report(error);
		}
	};

	/** @param {RemoteRepo} repo */
	const select = async (repo) => {
		selected = repo;
		branch = repo.defaultBranch ?? '';
		branches = repo.defaultBranch ? [repo.defaultBranch] : [];
		branchNotice = null;
		clearReport();
		if (repo.empty) return;
		try {
			const names = await authSession.listBranches(repo);
			if (selected !== repo) return;
			// GitHub's repo list cannot say this, and a repo with no branches has no commits.
			if (names.length === 0) {
				selected = { ...repo, empty: true };
				return;
			}
			// Keep the default branch on offer even if the list was cut short.
			branches = repo.defaultBranch && !names.includes(repo.defaultBranch) ? [repo.defaultBranch, ...names] : names;
		} catch (error) {
			if (selected === repo) branchNotice = `Only the default branch is on offer: ${error instanceof Error ? error.message : 'the branch list failed.'}`;
		}
	};

	const clone = async () => {
		if (!selected) return;
		const { url, fullName, provider: repoProvider } = selected;
		const ref = branch || undefined;
		const id = repoIdForUrl(url);
		const entry = { id, url, provider: repoProvider, fullName, branch, ready: false };
		clearReport();
		progress = 'Starting…';
		let recorded = false;
		/** @type {import('#lib/git/local-repos.js').LocalRepo | undefined} */
		let previous;
		try {
			previous = listLocalRepos().find((item) => item.id === id);
			// Recorded first, so a clone cut off by a closed tab can still be deleted.
			saveLocalRepo(entry);
			recorded = true;
			const repo = openDeviceRepo(entry);
			try {
				const result = await repo.clone({
					url,
					ref,
					onProgress: ({ phase, loaded: done, total }) => {
						progress = total ? `${phase}: ${Math.round((done / total) * 100)}%` : phase;
					}
				});
				saveLocalRepo({ ...entry, branch: result.branch, ready: true });
				selected = null;
			} catch (error) {
				if (!(error instanceof GitEngineError && error.code === ErrorCode.ALREADY_CLONED)) throw error;
				// Another tab got there first, perhaps with another branch.
				const onDevice = await repo.aheadBehind().then(
					(state) => state.branch,
					() => branch
				);
				saveLocalRepo({ ...entry, branch: onDevice, ready: true });
			}
		} catch (error) {
			report(error);
			if (recorded) await settleFailedClone({ entry, previous, isCloned: async () => openDeviceRepo(entry).isCloned() });
		} finally {
			progress = null;
		}
		await loadCopies();
	};

	/**
	 * @param {import('#lib/git/local-repos.js').LocalRepo} repo
	 * @returns {Promise<import('#lib/git/local-repos.js').LocalWork>}
	 */
	const countCopy = async (repo) => (await describeDeviceWork([repo]))[0];

	/** @param {import('#lib/git/local-repos.js').LocalRepo} repo */
	const startRemove = async (repo) => {
		clearReport();
		removing = { work: await countCopy(repo), changed: false };
	};

	/** Works with no account, as the copy may outlive its sign-in. */
	const finishRemove = async () => {
		if (!removing) return;
		const { work } = removing;
		clearReport();
		progress = 'Deleting…';
		try {
			// Another tab may have committed since the count was shown.
			if (await deleteDeviceRepo(work)) removing = null;
			else removing = { work: await countCopy(work.repo), changed: true };
		} catch (error) {
			report(error);
		} finally {
			progress = null;
		}
		await loadCopies();
	};

	onMount(async () => {
		try {
			accounts = await authSession.listAccounts();
		} catch (error) {
			report(error);
		}
		loaded = true;
		const first = accounts.find((item) => !item.needsSignIn) ?? accounts[0];
		await Promise.all([
			first ? loadRepos(first.provider) : null,
			loadCopies().catch(report),
			getStorageUsage()
				.catch(() => null)
				.then((usage) => {
					if (usage?.nearlyFull) {
						storageWarning = `This site uses ${formatBytes(usage.usage)} of the ${formatBytes(usage.quota)} this browser allows it. Near the limit, the browser may refuse writes or clear data, and unpushed commits exist nowhere else. Push them.`;
					}
				})
		]);
	});
</script>

<svelte:head>
	<title>Repositories - gitnote</title>
</svelte:head>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
	<header class="flex items-baseline justify-between gap-4">
		<h1 class="text-3xl font-bold">Repositories</h1>
		<span class="flex gap-4">
			<a class="underline" href={resolve('/settings')}>Settings</a>
			<a class="underline" href={resolve('/connect')}>Accounts</a>
		</span>
	</header>

	{#if storageWarning}
		<p role="alert" class="text-amber-800" data-testid="storage-warning">{storageWarning}</p>
	{/if}

	{#if failure}
		<p role="alert" class="text-red-700" data-testid="repos-error">
			{failure}
			{#if signInNeeded}
				<a class="underline" href={resolve('/connect')}>Go to accounts</a>
			{/if}
		</p>
	{/if}

	{#if loaded && accounts.length === 0}
		<p data-testid="no-accounts">No account is connected. <a class="underline" href={resolve('/connect')}>Connect one</a> to pick a repository.</p>
	{/if}

	{#if accounts.length > 1}
		<div class="flex gap-2">
			{#each accounts as item (item.provider)}
				<button type="button" class="rounded border border-gray-900 px-3 py-2 aria-pressed:bg-gray-900 aria-pressed:text-white" aria-pressed={item.provider === provider} onclick={() => loadRepos(item.provider)}>
					{PROVIDERS[item.provider].label}
				</button>
			{/each}
		</div>
	{/if}

	{#if account?.needsSignIn}
		<p role="alert" class="text-red-700">Your {PROVIDERS[account.provider].label} sign-in has ended. <a class="underline" href={resolve('/connect')}>Sign in again</a>; your notes on this device are safe.</p>
	{/if}

	{#if list}
		<section class="flex flex-col gap-3">
			<label class="flex flex-col gap-1">
				<span>Search repositories</span>
				<input class="rounded border border-gray-400 p-2" type="search" bind:value={search} data-testid="repo-search" />
			</label>

			{#if list.truncated}
				<p class="text-sm text-gray-600">You have more repositories than this list shows. These are the first ones.</p>
			{/if}
			{#if list.repos.length === 0}
				<p data-testid="no-repos">This sign-in cannot see any repositories yet.</p>
			{/if}
			{#if list.installUrl}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the provider's site, not an app route -->
				<a class="text-sm underline" href={list.installUrl} data-testid="install-link">Choose which repositories gitnote can use</a>
			{/if}

			<ul class="flex flex-col gap-1">
				{#each shown as repo (repo.id)}
					<li>
						<button type="button" class="w-full rounded border border-gray-300 p-2 text-left aria-pressed:border-gray-900" aria-pressed={selected?.id === repo.id} data-testid="repo-option" onclick={() => select(repo)}>
							<span class="font-medium">{repo.fullName}</span>
							<span class="text-sm text-gray-600">
								{repo.isPrivate ? 'private' : 'public'}{repo.sizeBytes === null ? '' : `, ${formatBytes(repo.sizeBytes)}`}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if selected}
		<section class="flex flex-col gap-3 rounded border border-gray-300 p-4" data-testid="clone-panel">
			<h2 class="text-xl font-semibold">{selected.fullName}</h2>
			<p data-testid="repo-size">Size: {selected.sizeBytes === null ? 'not reported' : formatBytes(selected.sizeBytes)}</p>
			{#if sizeWarning}
				<p role="alert" class="text-amber-800" data-testid="size-warning">{sizeWarning.message}</p>
			{/if}

			{#if selected.empty}
				<p data-testid="repo-empty">This repository has no commits yet. Add a first commit on {PROVIDERS[selected.provider].label}, then come back.</p>
			{:else if isOnDevice}
				<p data-testid="repo-on-device">This repository is already on this device.</p>
			{:else}
				<label class="flex flex-col gap-1">
					<span>Branch</span>
					<select class="rounded border border-gray-400 p-2" bind:value={branch} data-testid="branch-select">
						{#each branches as name (name)}
							<option value={name}>{name}</option>
						{/each}
					</select>
				</label>
				{#if branchNotice}
					<p class="text-sm text-gray-600">{branchNotice}</p>
				{/if}
				<button type="button" class="self-start rounded bg-gray-900 px-3 py-2 text-white disabled:opacity-50" disabled={progress !== null} onclick={clone} data-testid="clone-button">Clone to this device</button>
				{#if progress}
					<p role="status" data-testid="clone-progress">{progress}</p>
				{/if}
			{/if}
		</section>
	{/if}

	{#if copies.length > 0}
		<section class="flex flex-col gap-2">
			<h2 class="text-xl font-semibold">On this device</h2>
			<ul class="flex flex-col gap-1">
				{#each copies as { repo, files } (repo.id)}
					<li class="rounded border border-gray-300 p-2" data-testid="local-copy">
						{#if repo.ready}
							<a class="font-medium underline" href={resolve('/repo/[id]/[...path]', { id: encodeURIComponent(repo.id), path: '' })} data-testid="open-copy">{repo.fullName}</a>
						{:else}
							<span class="font-medium">{repo.fullName}</span>
						{/if}
						<span class="text-sm text-gray-600" data-testid="local-copy-state">{repo.branch}{describeCopy(repo, files)}</span>
						{#if removing?.work.repo.id === repo.id}
							<div class="mt-2 flex flex-col gap-2 rounded bg-gray-100 p-3" data-testid="remove-copy">
								{#if removing.changed}
									<p role="alert" class="text-amber-800">This copy changed while this was open. Check what it holds, then choose again.</p>
								{/if}
								<p>This deletes the copy from this device, including anything not pushed. It holds {describeWorkCounts(removing.work)}.</p>
								<div class="flex gap-2">
									<button type="button" class="rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" disabled={progress !== null} onclick={finishRemove}>Delete this copy</button>
									<button
										type="button"
										class="rounded border border-gray-900 px-3 py-2 disabled:opacity-50"
										disabled={progress !== null}
										onclick={() => {
											removing = null;
										}}>Keep it</button
									>
								</div>
							</div>
						{:else}
							<button type="button" class="ml-2 text-sm underline disabled:opacity-50" disabled={progress !== null} onclick={() => startRemove(repo)}>Delete from this device</button>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</main>
