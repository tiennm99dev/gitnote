<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { authSession } from '#lib/auth/index.js';
	import { isNative, watchSignInReturn } from '#lib/platform/native.js';
	import './layout.css';

	/** @type {{children: import('svelte').Snippet}} */
	let { children } = $props();

	let linkIgnored = $state(false);

	onMount(() => {
		if (!isNative()) return;
		return watchSignInReturn({
			isAwaited: (url) => authSession.isAwaitedCallback(url),
			open: (query) => {
				linkIgnored = false;
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- the path comes from resolve(), and the query is the provider's
				return goto(resolve('/auth/callback') + query, { replaceState: true });
			},
			ignored: () => {
				linkIgnored = true;
			}
		});
	});
</script>

<svelte:head>
	<title>gitnote</title>
</svelte:head>

{@render children()}

{#if linkIgnored}
	<div role="alert" class="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-4 bg-amber-100 p-3 text-amber-900" data-testid="sign-in-link-ignored">
		<p>A sign-in link was ignored: this device is not waiting for it, or it took too long. If you were signing in, start again.</p>
		<button
			type="button"
			class="underline"
			onclick={() => {
				linkIgnored = false;
			}}>Dismiss</button
		>
	</div>
{/if}
