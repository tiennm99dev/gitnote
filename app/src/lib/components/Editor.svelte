<script>
	import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
	import { EditorState } from '@codemirror/state';
	import { EditorView, keymap } from '@codemirror/view';
	import { minimalSetup } from 'codemirror';
	import { onMount, untrack } from 'svelte';
	import { lineSeparatorFor } from '#lib/notes/text.js';

	/**
	 * @typedef {object} Props
	 * @property {string} text the starting text; recreate this component to load another
	 * @property {boolean} isMarkdown
	 * @property {boolean} dirty
	 * @property {boolean} draftStored
	 * @property {(text: string) => void} onchange
	 * @property {() => void} onsave
	 * @property {(file: File) => void} onimage a pasted image
	 */

	/** @type {Props} */
	let { text, isMarkdown, dirty, draftStored, onchange, onsave, onimage } = $props();

	/** @type {HTMLDivElement} */
	let host;
	/** @type {EditorView | undefined} */
	let view;

	/**
	 * Inserts text at the cursor.
	 * @param {string} insertion
	 * @returns {void}
	 */
	export function insert(insertion) {
		if (!view) return;
		view.dispatch(view.state.replaceSelection(insertion));
		view.focus();
	}

	onMount(() => {
		const doc = untrack(() => text);
		const state = EditorState.create({
			doc,
			extensions: [
				// Reading back through `sliceDoc` then gives the file's exact bytes.
				EditorState.lineSeparator.of(lineSeparatorFor(doc)),
				keymap.of([
					{
						key: 'Mod-s',
						preventDefault: true,
						run: () => {
							onsave();
							return true;
						}
					}
				]),
				minimalSetup,
				EditorView.lineWrapping,
				...(untrack(() => isMarkdown) ? [markdown({ base: markdownLanguage })] : []),
				EditorView.contentAttributes.of({ 'aria-label': 'Note text' }),
				EditorView.theme({
					'&': { height: '100%', fontSize: '16px' },
					'&.cm-focused': { outline: 'none' },
					'.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
					'.cm-content': { padding: '0.75rem' }
				}),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) onchange(update.state.sliceDoc());
				}),
				EditorView.domEventHandlers({
					paste: (event) => {
						const image = [...(event.clipboardData?.files ?? [])].find((file) => file.type.startsWith('image/'));
						if (!image) return false;
						event.preventDefault();
						onimage(image);
						return true;
					}
				})
			]
		});
		view = new EditorView({ state, parent: host });
		return () => view?.destroy();
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="min-h-0 flex-1" bind:this={host} data-testid="note-editor"></div>
	<p class="border-t border-gray-200 px-3 py-1 text-sm text-gray-600" role="status" data-testid="dirty-indicator" data-dirty={dirty}>
		{#if !dirty}
			Saved to the working tree
		{:else if draftStored}
			Unsaved, kept on this device
		{:else}
			Unsaved
		{/if}
	</p>
</div>
