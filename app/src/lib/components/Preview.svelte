<script>
	import { onDestroy, tick, untrack } from 'svelte';
	import { createImageUrls, renderMarkdown } from '#lib/markdown/render.js';

	/**
	 * @typedef {object} Props
	 * @property {string} source the note's markdown
	 * @property {string} notePath fixed for this component's life
	 * @property {(path: string) => Promise<Uint8Array>} readFile
	 * @property {(path: string) => string} linkFor
	 */

	/** @type {Props} */
	let { source, notePath, readFile, linkFor } = $props();

	/** Typing in split view renders after a short pause. */
	const RENDER_DELAY_MS = 150;

	const images = createImageUrls({ readFile: (path) => readFile(path) });
	onDestroy(() => images.dispose());

	let html = $state('');
	/** @type {string | null} */
	let failure = $state(null);
	let renders = 0;
	let rendered = false;

	/** A link's fragment had nothing to find until the first render. */
	const showLinkedHeading = () => {
		try {
			document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
		} catch {
			// A malformed fragment names nothing.
		}
	};

	$effect(() => {
		const text = source;
		const render = async () => {
			renders += 1;
			const current = renders;
			try {
				const next = await renderMarkdown(text, { notePath: untrack(() => notePath), images, linkFor: untrack(() => linkFor) });
				if (current !== renders) return;
				html = next;
				failure = null;
				if (current === 1) {
					await tick();
					showLinkedHeading();
				}
			} catch (error) {
				if (current === renders) failure = error instanceof Error ? error.message : 'This note could not be shown.';
			}
		};
		if (!rendered) {
			rendered = true;
			void render();
			return;
		}
		const timer = setTimeout(render, RENDER_DELAY_MS);
		return () => clearTimeout(timer);
	});
</script>

{#if failure}
	<p role="alert" class="text-red-700">{failure}</p>
{/if}
<!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMarkdown's output is sanitized by DOMPurify -->
<article class="note-prose" data-testid="note-preview">{@html html}</article>
