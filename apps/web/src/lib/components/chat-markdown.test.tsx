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
