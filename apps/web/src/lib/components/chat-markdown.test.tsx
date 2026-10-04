import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
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

describe('links', () => {
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

	it('keeps copy feedback when the code streams during a pending clipboard write', async () => {
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

		await waitFor(() => expect(getByText('Copied')).toBeTruthy());
		expect(writeText).toHaveBeenCalledWith('const\n');
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
		expect(getAllByRole('button', { name: 'Copy code' })).toHaveLength(1);
		fireEvent.click(getByRole('button', { name: 'Copy code' }));

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
