import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { ArtifactEntry } from '$lib/chat/artifacts';
import { highlightCode } from '$lib/chat/code-highlighting';
import type { HighlightRequest, HighlightResponse } from '$lib/chat/code-highlighting-client';
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

describe('links', () => {
	it.each([
		['parse_file/screenshot.png', undefined, 'parse_file/screenshot.png', 'thread'],
		['parse_file/screenshot%2Epng', undefined, 'parse_file/screenshot.png', 'thread'],
		['./screenshot_url/board%20layout.PNG', undefined, 'screenshot_url/board layout.PNG', 'thread'],
		['scrape_url/board.webp', undefined, 'scrape_url/board.webp', 'thread'],
		['parse_file/board.png?download=1#preview', undefined, 'parse_file/board.png', 'thread'],
		['assets/board.svg', undefined, 'assets/board.svg', null],
		['/tmp/board.jpg', undefined, '/tmp/board.jpg', null],
		['parse_file/board.png', 'docs/notes.md', 'docs/parse_file/board.png', null]
	])(
		'renders local image link %s inline using its Markdown scope',
		(source, documentPath, path, threadId) => {
			const { getByRole } = render(
				<ChatMarkdown
					content={`[Rendering screenshot](${source})`}
					openLinksInNewTab
					imageScope={{
						workspacePath: '/workspace',
						documentPath,
						transcript: { userId: 'user', threadId: 'thread' }
					}}
				/>
			);

			const image = getByRole('button', { name: 'View Rendering screenshot' });
			const url = new URL(image.getAttribute('src') ?? '', window.location.href);

			expect(url.pathname).toBe('/api/workspace/image');
			expect(url.searchParams.get('path')).toBe(path);
			expect(url.searchParams.get('workspacePath')).toBe('/workspace');
			expect(url.searchParams.get('threadId')).toBe(threadId);
			expect(url.searchParams.get('userId')).toBe(threadId ? 'user' : null);
			expect(image.getAttribute('alt')).toBe('Rendering screenshot');
			expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
		}
	);

	it('uses the configured machine API for image links and updates their thread scope', () => {
		vi.stubEnv('VITE_LOCAL_API_URL', 'https://machine.example.com/');

		try {
			const { getByRole, rerender } = render(
				<ChatMarkdown
					content="[Screenshot](parse_file/screenshot.png)"
					imageScope={{ transcript: { userId: 'user', threadId: 'first' } }}
				/>
			);

			const url = () => new URL(getByRole('button').getAttribute('src') ?? '');
			expect(url().origin).toBe('https://machine.example.com');
			expect(url().searchParams.get('threadId')).toBe('first');

			rerender(
				<ChatMarkdown
					content="[Screenshot](parse_file/screenshot.png)"
					imageScope={{ transcript: { userId: 'user', threadId: 'second' } }}
				/>
			);
			expect(url().searchParams.get('threadId')).toBe('second');
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it.each(['docs/notes.md', 'assets/archive.zip', 'docs/notes.md?image=board.png', '#diagram.png'])(
		'preserves ordinary link %s',
		(source) => {
			const { getByRole } = render(
				<ChatMarkdown content={`[Link](${source})`} imageScope={{ workspacePath: '/workspace' }} />
			);

			expect(getByRole('link').getAttribute('href')).toBe(source);
		}
	);

	it.each(['https://example.com/board.png', '//example.com/board.png'])(
		'renders remote image link %s inline and opens the image viewer',
		(source) => {
			const { getByRole, container } = render(
				<ChatMarkdown
					content={`Before [**Board**](${source} "Board layout") after.`}
					openLinksInNewTab
				/>
			);

			const image = getByRole('button', { name: 'View Board' });
			expect(image.getAttribute('src')).toBe(source);
			expect(image.getAttribute('alt')).toBe('Board');
			expect(image.getAttribute('title')).toBe('Board layout');
			expect(container.querySelector('a')).toBeNull();
			expect(container.textContent?.trim()).toBe('Before  after.');
			fireEvent.click(image);
			expect(getByRole('dialog', { name: 'Image preview: Board' }).querySelector('img')?.src).toBe(
				new URL(source, window.location.href).href
			);
		}
	);

	it('preserves an explicitly linked image', () => {
		const { getByRole } = render(
			<ChatMarkdown content="[![Thumbnail](https://example.com/thumb.png)](https://example.com/full.png)" />
		);

		expect(getByRole('link').getAttribute('href')).toBe('https://example.com/full.png');
		expect(getByRole('img', { name: 'Thumbnail' }).getAttribute('src')).toBe(
			'https://example.com/thumb.png'
		);
	});

	it('opens the full-size local image from an explicitly linked thumbnail', () => {
		const { getByRole } = render(
			<ChatMarkdown
				content="[![Thumbnail](thumb.png)](full.png)"
				imageScope={{ workspacePath: '/workspace' }}
			/>
		);

		const link = new URL(getByRole('link').getAttribute('href') ?? '', window.location.href);

		const image = new URL(
			getByRole('img', { name: 'Thumbnail' }).getAttribute('src') ?? '',
			window.location.href
		);

		expect(link.pathname).toBe('/api/workspace/image');
		expect(link.searchParams.get('workspacePath')).toBe('/workspace');
		expect(link.searchParams.get('path')).toBe('full.png');
		expect(image.searchParams.get('path')).toBe('thumb.png');
	});

	it('opens links in a new tab when requested', () => {
		renderChatMarkdown({
			content: '[Sprocket](https://sprocket.dev)',
			openLinksInNewTab: true
		});

		const link = document.querySelector('a');
		expect(link?.target).toBe('_blank');
		expect(link?.rel).toBe('noopener noreferrer');
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

describe('images', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('does not watch a local image URL supplied in remote image HTML', () => {
		const { container } = render(
			<ChatMarkdown content='<img src="https://example.com/board.png" data-local-image-url="/api/workspace/image?path=/tmp/board.png" alt="Board">' />
		);

		expect(container.querySelector('img')?.hasAttribute('data-local-image-url')).toBe(false);
	});

	it('refreshes local images and the open viewer without replacing code blocks or remote images', async () => {
		vi.useFakeTimers();
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify('100-1')))
			.mockResolvedValueOnce(new Response(JSON.stringify('100-2')));

		vi.stubGlobal('fetch', fetch);

		const { container, getByRole, unmount } = render(
			<ChatMarkdown
				content={
					'![Board](/tmp/board.png)\n\n![Remote](https://example.com/remote.png)\n\n```\nhello\n```'
				}
			/>
		);

		const code = container.querySelector('pre');
		const remote = getByRole('button', { name: 'View Remote' }).getAttribute('src');
		const image = getByRole('button', { name: 'View Board' });
		await act(() => vi.advanceTimersByTimeAsync(2_000));
		const original = image.getAttribute('src');
		fireEvent.click(image);
		await act(() => vi.advanceTimersByTimeAsync(2_000));
		expect(image.getAttribute('src')).not.toBe(original);
		expect(getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(
			image.getAttribute('src')
		);
		expect(container.querySelector('pre')).toBe(code);
		expect(getByRole('button', { name: 'View Remote' }).getAttribute('src')).toBe(remote);
		expect(fetch).toHaveBeenCalledTimes(2);
		unmount();
	});

	it.each([
		'parse_file/board.png',
		'./parse_file/board%20layout.png',
		'screenshot_url/board.png',
		'scrape_url/board.png'
	])('resolves %s in the message thread instead of the workspace', (path) => {
		const { getByRole, rerender } = render(
			<ChatMarkdown
				content={`![Board](${path})`}
				imageScope={{
					workspacePath: '/workspace',
					transcript: { userId: 'user', threadId: 'first-thread' }
				}}
			/>
		);

		const url = new URL(
			getByRole('button', { name: 'View Board' }).getAttribute('src') ?? '',
			window.location.href
		);

		expect(url.searchParams.get('workspacePath')).toBe('/workspace');
		expect(url.searchParams.get('path')).toBe(decodeURIComponent(path.replace(/^\.\//, '')));
		expect(url.searchParams.get('userId')).toBe('user');
		expect(url.searchParams.get('threadId')).toBe('first-thread');

		rerender(
			<ChatMarkdown
				content={`![Board](${path})`}
				imageScope={{ transcript: { userId: 'user', threadId: 'second-thread' } }}
			/>
		);

		const nextUrl = new URL(
			getByRole('button', { name: 'View Board' }).getAttribute('src') ?? '',
			window.location.href
		);

		expect(nextUrl.searchParams.get('threadId')).toBe('second-thread');
	});

	it('watches thread-scoped images using credentials on the configured machine API', async () => {
		vi.stubEnv('VITE_LOCAL_API_URL', 'http://127.0.0.1:7731');
		vi.useFakeTimers();
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify('100-1')));
		vi.stubGlobal('fetch', fetch);

		const { getByRole, unmount } = render(
			<ChatMarkdown
				content="![Board](parse_file/board.png)"
				imageScope={{ transcript: { userId: 'user', threadId: 'thread' } }}
			/>
		);

		const image = getByRole('button', { name: 'View Board' });
		expect(image.getAttribute('crossorigin')).toBe('use-credentials');
		await act(() => vi.advanceTimersByTimeAsync(2_000));
		const request = new URL(fetch.mock.calls[0][0]);
		expect(request.origin).toBe('http://127.0.0.1:7731');
		expect(request.searchParams.get('userId')).toBe('user');
		expect(request.searchParams.get('threadId')).toBe('thread');
		expect(request.searchParams.get('revisionOnly')).toBe('true');
		expect(fetch.mock.calls[0][1].credentials).toBe('include');
		expect(new URL(image.getAttribute('src') ?? '').searchParams.get('revision')).toBe('100-1');
		unmount();
	});

	it.each([
		['assets/board.png', undefined, 'assets/board.png'],
		['/tmp/board.png', undefined, '/tmp/board.png'],
		['parse_file/board.png', 'docs/notes.md', 'docs/parse_file/board.png']
	])(
		'keeps %s workspace-relative or absolute when a thread scope exists',
		(path, documentPath, resolvedPath) => {
			const { getByRole } = render(
				<ChatMarkdown
					content={`![Board](${path})`}
					imageScope={{
						workspacePath: '/workspace',
						documentPath,
						transcript: { userId: 'user', threadId: 'thread' }
					}}
				/>
			);

			const url = new URL(
				getByRole('button', { name: 'View Board' }).getAttribute('src') ?? '',
				window.location.href
			);

			expect(url.searchParams.get('path')).toBe(resolvedPath);
			expect(url.searchParams.get('workspacePath')).toBe('/workspace');
			expect(url.searchParams.get('threadId')).toBeNull();
		}
	);

	it('restores enlargement after an initially missing local image becomes available', async () => {
		vi.useFakeTimers();
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify('100-1'))));
		const { getByRole, unmount } = render(<ChatMarkdown content="![Board](/tmp/board.png)" />);
		const image = getByRole('button', { name: 'View Board' });
		fireEvent.error(image);
		expect(getByRole('img', { name: 'Board (unavailable)' })).toBe(image);
		await act(() => vi.advanceTimersByTimeAsync(2_000));
		expect(getByRole('button', { name: 'View Board' })).toBe(image);
		fireEvent.keyDown(image, { key: 'Enter' });
		expect(getByRole('dialog', { name: 'Image preview: Board' })).toBeTruthy();
		unmount();
	});

	it.each([
		['![Board](file:///workspace/board%20layout.png)', '/workspace/board layout.png'],
		['![Board](file://assets/board.png)', 'assets/board.png'],
		['![Board](file://C:/workspace/board.png)', 'C:/workspace/board.png'],
		['![Board](file:///C:/workspace/board.png)', 'C:/workspace/board.png'],
		['![Board](file:///C:/workspace/board%20layout.png)', 'C:/workspace/board layout.png'],
		['<img src="file:///tmp/100%ready.png" alt="Board">', '/tmp/100%ready.png'],
		['<img src="file:///workspace/board.png" alt="Board">', '/workspace/board.png'],
		['<img src="file://C:/workspace/board.png" alt="Board">', 'C:/workspace/board.png']
	])('renders %s through the existing image path resolution', (content, path) => {
		const { getByRole } = render(
			<ChatMarkdown content={content} imageScope={{ workspacePath: '/workspace' }} />
		);

		const image = getByRole('button', { name: 'View Board' });
		const url = new URL(image.getAttribute('src') ?? '', 'http://localhost');

		expect(url.pathname).toBe('/api/workspace/image');
		expect(url.searchParams.get('path')).toBe(path);
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

	it.each(['![Board](/tmp/board.png)', '![Board](file:///tmp/board.png)'])(
		'renders %s without a workspace',
		(content) => {
			const { getByRole } = render(<ChatMarkdown content={content} />);
			const image = getByRole('button', { name: 'View Board' });
			const url = new URL(image.getAttribute('src') ?? '', 'http://localhost');

			expect(url.searchParams.get('path')).toBe('/tmp/board.png');
		}
	);

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
