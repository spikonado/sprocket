import { afterEach, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { highlightCode } from '$lib/chat/code-highlighting';
import type { HighlightRequest, HighlightResponse } from '$lib/chat/code-highlighting-client';
import ChatMarkdown from './chat-markdown';

afterEach(() => vi.unstubAllGlobals());

it('highlights a code block once it closes and keeps its DOM while text streams after it', async () => {
	const requests: string[] = [];

	vi.stubGlobal(
		'Worker',
		class {
			onmessage?: (event: MessageEvent<HighlightResponse>) => void;
			async postMessage({ id, code, language }: HighlightRequest) {
				requests.push(code);
				const tokens = await highlightCode(code, language);
				this.onmessage?.(new MessageEvent('message', { data: { id, tokens } }));
			}
		}
	);

	const { container, rerender } = render(<ChatMarkdown content={'```ts\nconst a'} />);

	rerender(<ChatMarkdown content={'```ts\nconst a = 1;\n'} />);
	await waitFor(() =>
		expect(container.querySelector('.markdown-code-header button')).not.toBeNull()
	);
	expect(requests).toEqual([]);

	let content = '```ts\nconst a = 1;\n```\n\nAfter';
	rerender(<ChatMarkdown content={content} />);
	await waitFor(() => expect(container.querySelector('pre code.shiki span')).not.toBeNull());
	const code = container.querySelector('pre code');

	for (const tail of [' the', ' code', '.\n\nNext']) {
		content += tail;
		rerender(<ChatMarkdown content={content} />);
	}

	expect(container.querySelector('pre code')).toBe(code);
	expect(code?.classList.contains('shiki')).toBe(true);
	expect(requests).toEqual(['const a = 1;\n']);
	expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
		'After the code.',
		'Next'
	]);
});
