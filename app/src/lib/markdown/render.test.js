// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createImageUrls, renderMarkdown } from './render.js';

/**
 * Renders with an in-memory working tree. URLs are made by a stand-in, as jsdom
 * has no `URL.createObjectURL`; the browser tests load real ones.
 * @param {string} source
 * @param {Record<string, string>} [files]
 * @param {string} [notePath]
 * @returns {Promise<{ html: string, dom: HTMLElement, blobs: Blob[], revoked: string[], dispose: () => void }>}
 */
async function render(source, files = {}, notePath = 'notes/today.md') {
	/** @type {Blob[]} */
	const blobs = [];
	/** @type {string[]} */
	const revoked = [];
	const images = createImageUrls({
		readFile: async (path) => {
			if (!(path in files)) throw new Error(`no ${path}`);
			return new TextEncoder().encode(files[path]);
		},
		createUrl: (blob) => {
			blobs.push(blob);
			return `blob:http://app/${blobs.length}`;
		},
		revokeUrl: (url) => revoked.push(url)
	});
	const html = await renderMarkdown(source, { notePath, images, linkFor: (path) => `/repo/x/${path}` });
	const dom = document.createElement('div');
	dom.innerHTML = html;
	return { html, dom, blobs, revoked, dispose: images.dispose };
}

describe('sanitizing', () => {
	it('removes a script and never runs it', async () => {
		const { dom } = await render('before\n\n<script>globalThis.ran = true</script>\n\nafter <script>x()</script>');
		expect(dom.querySelector('script')).toBeNull();
		expect(dom.textContent).toContain('before');
		expect(dom.textContent).toContain('after');
	});

	it('shows a script inside code as text', async () => {
		const { dom } = await render('`<script>alert(1)</script>`');
		expect(dom.querySelector('script')).toBeNull();
		expect(dom.querySelector('code')?.textContent).toBe('<script>alert(1)</script>');
	});

	it('strips onerror and other handlers', async () => {
		const { html } = await render('<img src="x.png" onerror="alert(1)">\n\n<a href="https://example.com" onclick="alert(1)">x</a>\n\n<div onmouseover="alert(1)">y</div>');
		expect(html).not.toMatch(/onerror|onclick|onmouseover|alert/);
	});

	it('removes javascript and blob links, written as markdown or HTML', async () => {
		const { dom } = await render('[a](javascript:alert(1))\n\n<a href="javascript:alert(1)">b</a>\n\n<a href="blob:http://app/1">c</a>\n\n<img src="blob:http://app/1">');
		expect(dom.querySelectorAll('a[href]')).toHaveLength(0);
		expect(dom.innerHTML).not.toContain('blob:');
	});

	it('keeps harmless raw HTML', async () => {
		const { dom } = await render('<details><summary>More</summary>\n\nHidden <kbd>x</kbd>\n\n</details>');
		expect(dom.querySelector('details summary')?.textContent).toBe('More');
		expect(dom.querySelector('kbd')?.textContent).toBe('x');
	});

	it('removes what could pose as the app or send data away', async () => {
		const { dom } = await render('<style>body{display:none}</style>\n\n<form action="https://example.com"><input name="a"><button>go</button></form>\n\n<div style="position:fixed" class="fixed inset-0">z</div>\n\n<iframe src="https://example.com"></iframe>');
		expect(dom.querySelector('style, form, input, button, iframe')).toBeNull();
		expect(dom.querySelector('[style], [class]')).toBeNull();
		expect(dom.textContent).toContain('z');
	});

	it('cannot shadow document properties with a name', async () => {
		const { dom } = await render('<img name="cookie" src="data:image/png;base64,AA">\n\n<a id="getElementById" href="#x">x</a>');
		expect(dom.querySelector('img')?.getAttribute('name')).not.toBe('cookie');
		expect(dom.querySelector('a')?.getAttribute('id')).not.toBe('getElementById');
	});
});

describe('markdown', () => {
	it('keeps task lists, checked state included, with inert boxes', async () => {
		const { dom } = await render('- [x] done\n- [ ] open\n');
		const boxes = /** @type {HTMLInputElement[]} */ ([...dom.querySelectorAll('li input[type="checkbox"]')]);
		expect(boxes).toHaveLength(2);
		expect(boxes.map((box) => box.checked)).toEqual([true, false]);
		expect(boxes.every((box) => box.disabled)).toBe(true);
		expect(dom.querySelectorAll('li')[0].textContent?.trim()).toBe('done');
	});

	it('keeps tables and their column alignment', async () => {
		const { dom } = await render('| a | b |\n| :-- | --: |\n| 1 | 2 |\n');
		expect(dom.querySelectorAll('table th')).toHaveLength(2);
		expect(dom.querySelector('tbody td')?.textContent).toBe('1');
		expect(dom.querySelectorAll('th')[1].getAttribute('align')).toBe('right');
		expect(dom.querySelector('[style]')).toBeNull();
	});

	it('leaves out front matter', async () => {
		const { dom } = await render('---\ntitle: secret plan\ntags: [a]\n---\n# Heading\n');
		expect(dom.textContent).not.toContain('secret plan');
		expect(dom.querySelector('h1')?.textContent).toBe('Heading');
	});

	it('keeps a leading rule that opens no front matter', async () => {
		const { dom } = await render('---\n\nJust text\n');
		expect(dom.querySelector('hr')).not.toBeNull();
		expect(dom.textContent).toContain('Just text');
	});

	it('ignores a byte order mark', async () => {
		const { dom } = await render('﻿# Heading\n');
		expect(dom.querySelector('h1')?.textContent).toBe('Heading');
	});
});

describe('images', () => {
	it('resolves a relative image to a blob URL of the file next to the note', async () => {
		const { dom, blobs } = await render('![](./img.png)', { 'notes/img.png': 'pixels' });
		expect(dom.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
		expect(blobs).toHaveLength(1);
		expect(blobs[0].type).toBe('image/png');
		expect(blobs[0].size).toBe(6);
	});

	it('resolves parent, root and encoded paths', async () => {
		const { dom } = await render('![](../top.gif)\n\n![](/root.webp)\n\n![](my%20pic.jpg)', { 'top.gif': 'g', 'root.webp': 'w', 'notes/my pic.jpg': 'j' });
		const sources = [...dom.querySelectorAll('img')].map((image) => image.getAttribute('src'));
		expect(sources).toHaveLength(3);
		for (const source of sources) expect(source).toMatch(/^blob:/);
	});

	it('gives SVG a blob URL only inside an img', async () => {
		const { dom, blobs } = await render('![](a.svg)\n\n[open](a.svg)', { 'notes/a.svg': '<svg><script>alert(1)</script></svg>' });
		expect(blobs[0].type).toBe('image/svg+xml');
		expect(dom.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
		expect(dom.querySelector('a')?.getAttribute('href')).toBe('/repo/x/notes/a.svg');
	});

	it('makes no blob URL for a type outside the allowlist', async () => {
		const { dom, blobs } = await render('![](page.html)\n\n<img src="page.htm">\n\n![](x.js)', { 'notes/page.html': '<script></script>', 'notes/page.htm': 'h', 'notes/x.js': 'j' });
		expect(blobs).toHaveLength(0);
		for (const image of dom.querySelectorAll('img')) expect(image.hasAttribute('src')).toBe(false);
	});

	it('marks a missing file, and never leaves a same-origin request behind', async () => {
		const { dom } = await render('![gone](nothing.png)');
		const image = dom.querySelector('img');
		expect(image?.hasAttribute('src')).toBe(false);
		expect(image?.getAttribute('alt')).toBe('gone');
		expect(image?.getAttribute('data-missing')).toBe('true');
	});

	it('refuses paths out of the repository or into git', async () => {
		const { dom, blobs } = await render('![](../../../x.png)\n\n![](.git/x.png)\n\n![](..%2F..%2F..%2Fx.png)', { 'x.png': 'p', '.git/x.png': 'p' });
		expect(blobs).toHaveLength(0);
		for (const image of dom.querySelectorAll('img')) expect(image.hasAttribute('src')).toBe(false);
	});

	it('turns a remote image, which the CSP blocks, into a link', async () => {
		const { dom } = await render('![cat](https://example.com/cat.png)');
		expect(dom.querySelector('img')).toBeNull();
		const link = dom.querySelector('a');
		expect(link?.getAttribute('href')).toBe('https://example.com/cat.png');
		expect(link?.textContent).toBe('cat');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('reads an image once across renders and revokes its URL on dispose', async () => {
		let reads = 0;
		/** @type {string[]} */
		const revoked = [];
		const images = createImageUrls({
			readFile: async () => {
				reads += 1;
				return new Uint8Array([1]);
			},
			createUrl: () => 'blob:http://app/1',
			revokeUrl: (url) => revoked.push(url)
		});
		const context = { notePath: 'a.md', images, linkFor: (/** @type {string} */ path) => path };
		await renderMarkdown('![](a.png)', context);
		await renderMarkdown('edited ![](a.png)', context);
		expect(reads).toBe(1);
		images.dispose();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(revoked).toEqual(['blob:http://app/1']);
		expect(await images.urlFor('a.png')).toBeNull();
	});
});

describe('links', () => {
	it('opens other notes in the app, keeping a heading link', async () => {
		const { dom } = await render('[next](./next.md)\n\n[up](../index.md#top)\n\n[spaced](my%20note.md)');
		const hrefs = [...dom.querySelectorAll('a')].map((link) => link.getAttribute('href'));
		expect(hrefs).toEqual(['/repo/x/notes/next.md', '/repo/x/index.md#top', '/repo/x/notes/my note.md']);
		expect(dom.querySelector('a')?.hasAttribute('target')).toBe(false);
	});

	it('opens web links in a new tab with no referrer', async () => {
		const { dom } = await render('[site](https://example.com/a)');
		const link = dom.querySelector('a');
		expect(link?.getAttribute('href')).toBe('https://example.com/a');
		expect(link?.getAttribute('target')).toBe('_blank');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('leaves in-page links alone and drops one that leaves the repository', async () => {
		const { dom } = await render('[here](#section)\n\n[out](../../../etc.md)');
		const [here, out] = dom.querySelectorAll('a');
		expect(here.getAttribute('href')).toBe('#section');
		expect(out.hasAttribute('href')).toBe(false);
	});
});
