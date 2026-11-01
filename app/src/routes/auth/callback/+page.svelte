<script>
	import { afterNavigate, goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authSession } from '#lib/auth/index.js';

	/** @type {string | null} */
	let failure = $state(null);

	/** Tells the latest callback from one still waiting on the provider. */
	let attempts = 0;

	// SvelteKit keeps this component when a second callback arrives while it shows the
	// first one's outcome, so each navigation is handled here rather than on mount.
	afterNavigate(async () => {
		attempts += 1;
		const attempt = attempts;
		failure = null;
		const callbackUrl = location.href;
		// The code should not stay in the address bar or the history.
		replaceState(resolve('/auth/callback'), {});
		try {
			await authSession.completeSignIn(callbackUrl);
			if (attempt === attempts) await goto(resolve('/repos'), { replaceState: true });
		} catch (error) {
			if (attempt === attempts) failure = error instanceof Error ? error.message : 'The sign-in failed.';
		}
	});
</script>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 p-6">
	{#if failure}
		<h1 class="text-2xl font-bold">Sign-in failed</h1>
		<p role="alert" data-testid="callback-error">{failure}</p>
		<a class="underline" href={resolve('/connect')}>Back to accounts</a>
	{:else}
		<p role="status">Finishing sign-in…</p>
	{/if}
</main>
