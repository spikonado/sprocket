import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import { highlightCode } from '$lib/chat/code-highlighting';
import type { HighlightRequest, HighlightResponse } from '$lib/chat/code-highlighting-client';
import { MarkdownFileLinksContext } from '$lib/chat/markdown-file-links';
import ChatMarkdown from './chat-markdown';

const artifact: ArtifactEntry = {
	key: 'ks73zzsnfj2najtd871p43f45s8ec23d',
	title: 'About Me.md',
	artifactType: 'markdown',
	content: '# About me'
};

function renderChatMarkdown(props: {
	content: string;
	artifacts?: ArtifactEntry[];
	onOpenArtifact?: (artifactId: string) => void;
	openLinksInNewTab?: boolean;
}) {
	render(<ChatMarkdown {...props} />);
}

describe('math', () => {
	it('renders completed formulas as a transcript message streams', () => {
		const { container, rerender } = render(
			<ChatMarkdown content={String.raw`Result: $\frac{1}`} />
		);

		expect(container.textContent).toBe(String.raw`Result: $\frac{1}` + '\n');

		rerender(<ChatMarkdown content={String.raw`Result: $\frac{1}{2}$` + '\n\n\\[x^2\\]'} />);

		expect(container.querySelectorAll('.katex')).toHaveLength(2);
		expect(container.querySelector('.katex-display math')?.getAttribute('display')).toBe('block');
		expect(container.querySelector('math mfrac')?.textContent).toBe('12');
		expect(container.querySelector('.frac-line')?.getAttribute('style')).toContain(
			'border-bottom-width'
		);
	});

	it('preserves sanitized math, nested Markdown, and literal code together', () => {
		const content = [
			String.raw`- **Voltage:** $V = IR$`,
			String.raw`> \[\sqrt{x^2 + y^2}\]`,
			'Example: `$x^2$`',
			String.raw`$\href{javascript:alert(1)}{click}$`,
			'<img src=x onerror="alert(1)"><script>alert(1)</script>'
		].join('\n\n');

		const { container } = render(<ChatMarkdown content={content} />);

		expect(container.querySelector('li .katex')).not.toBeNull();
		expect(container.querySelector('blockquote .katex-display')).not.toBeNull();
		expect(container.querySelector('code')?.textContent).toBe('$x^2$');
		expect(container.querySelector('.katex-html .mord.text')?.textContent).toBe(String.raw`\href`);
		expect(container.querySelector('script, [onerror], a[href^="javascript:"]')).toBeNull();
	});
});

describe('json-render', () => {
	const card = '{"type":"Card","props":{"title":"CI"},"children":["jobs"]}';
	const table = '{"type":"Table","props":{"columns":["Job"],"rows":[["lint"]]},"children":[]}';

	it('builds the UI from JSONL patches as the fence streams', async () => {
		const patches = [
			'{"op":"add","path":"/root","value":"ci"}',
			`{"op":"add","path":"/elements/ci","value":${card}}`
		];

		const { container, findByText, rerender } = render(
			<ChatMarkdown content={'```json-render\n' + patches.join('\n')} />
		);

		expect(await findByText('CI')).not.toBeNull();
		expect(container.querySelector('table')).toBeNull();

		patches.push(`{"op":"add","path":"/elements/jobs","value":${table}}`);
		rerender(<ChatMarkdown content={'```json-render\n' + patches.join('\n') + '\n```'} />);

		expect(await findByText('lint')).not.toBeNull();
	});

	it('renders a whole spec document', async () => {
		const spec = `{"root":"ci","elements":{"ci":${card},"jobs":${table}}}`;
		const { findByText } = render(<ChatMarkdown content={'```json-render\n' + spec + '\n```'} />);

		expect(await findByText('lint')).not.toBeNull();
	});
});

describe('links', () => {
	it.each(['docs/notes.md', 'assets/board.png', 'https://example.com/board.png', '#diagram.png'])(
		'preserves ordinary link %s',
		(source) => {
			const { getByRole } = render(
				<ChatMarkdown content={`[Link](${source})`} imageScope={{ workspacePath: '/workspace' }} />
			);

			expect(getByRole('link').getAttribute('href')).toBe(source);
		}
	);

	it('opens links in a new tab when requested', () => {
		renderChatMarkdown({
			content: '[Sprocket](https://sprocket.dev)',
			openLinksInNewTab: true
		});

		const link = document.querySelector('a');
		expect(link?.target).toBe('_blank');
		expect(link?.rel).toBe('noopener noreferrer');
	});

	it('opens local path links in the files tab', () => {
		const open = vi.fn();

		const { getByRole } = render(
			<MarkdownFileLinksContext value={{ roots: ['/repo'], open }}>
				<ChatMarkdown
					content="[main](src/main.rs) [lib](/repo/src/lib.rs) [site](https://sprocket.dev) [call](tel:1234567890) [![thumb](thumb.png)](full.png)"
					imageScope={{ workspacePath: '/repo' }}
					openLinksInNewTab
				/>
			</MarkdownFileLinksContext>
		);

		for (const name of ['main', 'lib', 'site', 'call', 'thumb']) {
			fireEvent.click(getByRole('link', { name }));
		}

		expect(open.mock.calls).toEqual([
			[{ workspacePath: '/repo', path: 'src/main.rs', directory: false }],
			[{ workspacePath: '/repo', path: 'src/lib.rs', directory: false }],
			[{ workspacePath: '/repo', path: 'full.png', directory: false }]
		]);
	});
});

it('preserves GFM table column alignment through parsing and sanitization', () => {
	const { container } = render(
		<ChatMarkdown
			content={'| Sensor | Status | Value |\n| :--- | :---: | ---: |\n| Voltage | Ready | 3.3 |'}
		/>
	);

	const alignments = (selector: string) =>
		[...container.querySelectorAll(selector)].map((cell) => cell.getAttribute('align'));

	expect(alignments('th')).toEqual(['left', 'center', 'right']);
	expect(alignments('td')).toEqual(['left', 'center', 'right']);
});

describe('code blocks', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'Worker',
			class {
				onmessage?: (event: MessageEvent<HighlightResponse>) => void;
				async postMessage({ id, code, language }: HighlightRequest) {
					const tokens = await highlightCode(code, language);
					this.onmessage?.(new MessageEvent('message', { data: { id, tokens } }));
				}
			}
		);
	});

	afterEach(() => vi.unstubAllGlobals());

	it('wraps each block independently and keeps wrapping as highlighted code streams', async () => {
		const content = '```ts\nconst reading = 23.4;\n```\n\n```\necho ready\n```';

		const { container, getAllByRole, getByRole, rerender } = render(
			<StrictMode>
				<ChatMarkdown content={content} />
			</StrictMode>
		);

		fireEvent.click(getAllByRole('button', { name: 'Enable line wrapping' })[0]);
		expect(
			getByRole('button', { name: 'Disable line wrapping' }).getAttribute('aria-pressed')
		).toBe('true');
		expect(container.querySelectorAll('pre.markdown-code-wrap')).toHaveLength(1);

		rerender(
			<StrictMode>
				<ChatMarkdown content={content.replace('23.4;', '23.4;\nconsole.log(reading);')} />
			</StrictMode>
		);
		await waitFor(() => expect(container.querySelector('pre code.shiki span')).not.toBeNull());
		expect(container.querySelectorAll('pre.markdown-code-wrap')).toHaveLength(1);
		expect(container.querySelector('pre.markdown-code-wrap code')?.textContent).toBe(
			'const reading = 23.4;\nconsole.log(reading);\n'
		);
		expect(container.querySelectorAll('.markdown-code-header')).toHaveLength(2);

		fireEvent.click(getByRole('button', { name: 'Disable line wrapping' }));
		expect(container.querySelector('pre.markdown-code-wrap')).toBeNull();
		expect(getAllByRole('button', { name: 'Enable line wrapping' })).toHaveLength(2);
	});

	it('highlights nested fences while preserving literal code, tabs, and blank lines', async () => {
		const code = 'const markup = "<img src=x onerror=alert(1)>";\n\n\tconsole.log(markup);\n';

		const { container } = render(
			<ChatMarkdown
				content={`> \`\`\`ts\n${code
					.split('\n')
					.map((line) => `> ${line}`)
					.join('\n')}\`\`\``}
			/>
		);

		await waitFor(() => expect(container.querySelector('pre code.shiki span')).not.toBeNull());
		expect(container.querySelector('pre code')?.textContent).toBe(code);
		expect(container.querySelector('img')).toBeNull();
	});

	it('renders the latest code when an unfinished fence streams more content', async () => {
		const { container, rerender } = render(<ChatMarkdown content={'```js\nconst'} />);
		const code = 'const reading = 23.4;\n';
		rerender(<ChatMarkdown content={`\`\`\`js\n${code}\`\`\``} />);

		await waitFor(() => expect(container.querySelector('pre code.shiki span')).not.toBeNull());
		expect(container.querySelector('pre code')?.textContent).toBe(code);
	});
});

describe('copying code', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('identifies the copied snapshot when code streams during a pending clipboard write', async () => {
		let finish: () => void = () => {};

		const writeText = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);

		vi.stubGlobal('navigator', { clipboard: { writeText } });
		const { getByRole, getByText, rerender } = render(<ChatMarkdown content={'```\nconst'} />);
		fireEvent.click(getByRole('button', { name: 'Copy code' }));
		rerender(<ChatMarkdown content={'```\nconst reading = 23.4;\n```'} />);
		finish();

		await waitFor(() => expect(getByText('Copied earlier')).toBeTruthy());
		expect(writeText).toHaveBeenCalledWith('const\n');
		expect(getByRole('button', { name: 'Copy current code' })).toBeTruthy();
	});

	it('updates copy feedback when code grows after copying and lets the user copy the current version', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		const { getByRole, getByText, rerender } = render(<ChatMarkdown content={'```\nconst'} />);
		fireEvent.click(getByRole('button', { name: 'Copy code' }));

		await waitFor(() => expect(getByText('Copied')).toBeTruthy());
		rerender(<ChatMarkdown content={'```\nconst reading = 23.4;\n```'} />);

		expect(getByText('Copied earlier')).toBeTruthy();
		fireEvent.click(getByRole('button', { name: 'Copy current code' }));

		await waitFor(() => expect(getByText('Copied')).toBeTruthy());
		expect(writeText).toHaveBeenLastCalledWith('const reading = 23.4;\n');
	});

	it('copies each block verbatim without including controls or Markdown fences', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		const code = '<div>sensor</div>\n\n\treading = 23.4;\n';

		const { getAllByRole, getByText } = render(
			<StrictMode>
				<ChatMarkdown content={`\`\`\`\n${code}\`\`\`\n\n    echo ready`} />
			</StrictMode>
		);

		const buttons = getAllByRole('button', { name: 'Copy code' });
		fireEvent.click(buttons[0]);

		await waitFor(() => expect(getByText('Copied')).toBeTruthy());
		expect(writeText).toHaveBeenCalledWith(code);
		fireEvent.click(buttons[1]);

		await waitFor(() => expect(writeText).toHaveBeenCalledWith('echo ready\n'));
	});

	it('offers a retry after a failed clipboard write and copies the latest streamed block', async () => {
		const writeText = vi
			.fn()
			.mockRejectedValueOnce(new Error('Clipboard denied'))
			.mockResolvedValue(undefined);

		vi.stubGlobal('navigator', { clipboard: { writeText } });

		const { getAllByRole, getByRole, getByText, rerender } = render(
			<StrictMode>
				<ChatMarkdown content={'```\nconst'} />
			</StrictMode>
		);

		fireEvent.click(getByRole('button', { name: 'Copy code' }));

		await waitFor(() => expect(getByText('Copy failed')).toBeTruthy());
		fireEvent.click(getByRole('button', { name: 'Retry copying code' }));

		await waitFor(() => expect(getByText('Copied')).toBeTruthy());
		rerender(
			<StrictMode>
				<ChatMarkdown content={'```\nconst reading = 23.4;\n```'} />
			</StrictMode>
		);
		expect(getAllByRole('button', { name: 'Copy current code' })).toHaveLength(1);
		fireEvent.click(getByRole('button', { name: 'Copy current code' }));

		await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('const reading = 23.4;\n'));
	});
});

describe('artifact references', () => {
	it('shows the artifact title and opens it from the view button', () => {
		const onOpenArtifact = vi.fn();
		renderChatMarkdown({
			content: `Here it is.\n\nartifact:${artifact.key}`,
			artifacts: [artifact],
			onOpenArtifact
		});

		const reference = document.querySelector(`[data-artifact-reference="${artifact.key}"]`);
		expect(reference?.textContent).toContain('About Me.md');
		expect(reference?.textContent).toContain('Artifact');

		fireEvent.click(reference!.querySelector<HTMLButtonElement>('button')!);
		expect(onOpenArtifact).toHaveBeenCalledOnce();
		expect(onOpenArtifact).toHaveBeenCalledWith(artifact.key);
	});

	it('keeps an unavailable artifact reference as text', () => {
		renderChatMarkdown({
			content: 'artifact:missing',
			artifacts: [artifact],
			onOpenArtifact: vi.fn()
		});

		expect(document.querySelector('[data-artifact-reference]')).toBeNull();
		expect(document.body.textContent).toContain('artifact:missing');
	});
});

it('opens a KiCad project card in the side panel', () => {
	const open = vi.fn();

	const { getByRole } = render(
		<MarkdownFileLinksContext value={{ roots: ['/repo'], open }}>
			<ChatMarkdown content={'Done.\n\nkicad:boards/amp board/amp.kicad_pro'} />
		</MarkdownFileLinksContext>
	);

	expect(document.querySelector('[data-kicad-reference]')?.textContent).toContain('KiCad project');
	fireEvent.click(getByRole('button', { name: 'View amp.kicad_pro' }));
	expect(open).toHaveBeenCalledWith({
		workspacePath: '/repo',
		path: 'boards/amp board/amp.kicad_pro',
		directory: false
	});
});

describe('images', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('offers the original remote image instead of CORS-dependent read actions', () => {
		const { getByRole, queryByRole } = render(
			<ChatMarkdown content="![Board](https://example.com/board.png)" />
		);

		fireEvent.click(getByRole('button', { name: 'View Board' }));

		expect(getByRole('link', { name: 'Open original image' }).getAttribute('href')).toBe(
			'https://example.com/board.png'
		);
		expect(queryByRole('button', { name: 'Copy image' })).toBeNull();
	});

	it('loads a re-sent local image fresh in each new message but keeps it across re-renders', () => {
		const content = '![Board](/tmp/board.png)';

		const { getAllByRole, rerender } = render(
			<>
				<ChatMarkdown content={content} />
			</>
		);

		const [first] = getAllByRole('button', { name: 'View Board' });
		const firstUrl = first!.getAttribute('src');

		rerender(
			<>
				<ChatMarkdown content={content} />
				<ChatMarkdown content={content} />
			</>
		);

		const [kept, resent] = getAllByRole('button', { name: 'View Board' });
		expect(kept!.getAttribute('src')).toBe(firstUrl);
		expect(resent!.getAttribute('src')).not.toBe(firstUrl);
	});

	it('sends credentials with images from a separate machine API', () => {
		vi.stubEnv('VITE_LOCAL_API_URL', 'https://machine.example.com/');

		const { getByRole } = render(
			<ChatMarkdown content="![Board](board.png)" imageScope={{ workspacePath: '/workspace' }} />
		);

		expect(getByRole('button', { name: 'View Board' }).getAttribute('crossorigin')).toBe(
			'use-credentials'
		);
	});

	it('renders Windows absolute image paths through sanitization', () => {
		const { getByRole } = render(
			<ChatMarkdown
				content="![Board](C:/workspace/board.png)"
				imageScope={{ workspacePath: 'C:/workspace' }}
			/>
		);

		const image = getByRole('button', { name: 'View Board' });
		const url = new URL(image.getAttribute('src') ?? '', 'http://localhost');

		expect(url.searchParams.get('path')).toBe('C:/workspace/board.png');
	});

	it('shows local images as unavailable without a connected workspace', () => {
		const { getByRole } = render(<ChatMarkdown content="![Board](assets/board.png)" />);
		const image = getByRole('img', { name: 'Board (unavailable)' });

		expect(image.getAttribute('src')).toBeNull();
	});

	it('renders local Markdown images and opens them with keyboard-accessible enlargement', async () => {
		const { getByRole, queryByRole } = render(
			<ChatMarkdown
				content="![Board layout](../assets/board%20layout.png)"
				imageScope={{ workspacePath: '/workspace', documentPath: 'docs/notes.md' }}
			/>
		);

		const trigger = getByRole('button', { name: 'View Board layout' });

		expect(trigger.getAttribute('src')).toContain('path=docs%2F..%2Fassets%2Fboard+layout.png');
		expect(trigger.getAttribute('loading')).toBe('lazy');
		expect(trigger.getAttribute('referrerpolicy')).toBe('no-referrer');
		trigger.focus();
		fireEvent.keyDown(trigger, { key: 'Enter' });

		expect(getByRole('dialog', { name: 'Image preview: Board layout' })).toBeTruthy();
		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(queryByRole('dialog')).toBeNull());
		expect(document.activeElement).toBe(trigger);
	});

	it('keeps linked images as links and presents failed loads as unavailable', () => {
		const { getByRole, container } = render(
			<ChatMarkdown
				content={
					'[![Documentation](https://example.com/logo.png)](https://example.com)\n\n![Missing board](https://example.com/missing.png)'
				}
			/>
		);

		expect(getByRole('link').getAttribute('href')).toBe('https://example.com');
		const trigger = getByRole('button', { name: 'View Missing board' });
		fireEvent.error(trigger);

		expect(container.querySelector('img.markdown-image-error')?.getAttribute('alt')).toBe(
			'Missing board (unavailable)'
		);
		expect(trigger.hasAttribute('tabindex')).toBe(false);
	});
});
