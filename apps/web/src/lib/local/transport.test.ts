import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLocalTransport, readEventStream } from './transport';

function streamResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			}
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('local event stream transport', () => {
	it('parses CRLF events split across response chunks', async () => {
		const onData = vi.fn();
		await readEventStream(
			streamResponse([
				': keepalive\r\ndata: first\r',
				'\ndata: second\r\n\r',
				'\ndata: third\r\n\r\n'
			]),
			new AbortController().signal,
			onData
		);

		expect(onData.mock.calls).toEqual([['first\nsecond'], ['third']]);
	});

	it('accepts the field form without a colon', async () => {
		const onData = vi.fn();
		await readEventStream(
			streamResponse(['event: update\ndata\ndata: value\n\n']),
			new AbortController().signal,
			onData
		);

		expect(onData).toHaveBeenCalledWith('\nvalue');
	});
});

describe('local JSON transport', () => {
	it('returns the server error from failed requests', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ error: 'workspace is unavailable' }, { status: 409 }))
		);

		await expect(
			createLocalTransport('http://127.0.0.1:7731').request('/api/test', z.string())
		).rejects.toThrow('workspace is unavailable');
	});

	it('reports malformed JSON as an unexpected API response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response('{not json', {
						headers: { 'content-type': 'application/json' }
					})
			)
		);

		await expect(
			createLocalTransport('http://127.0.0.1:7731').request('/api/test', z.string())
		).rejects.toThrow('Local API returned an unexpected response: {not json');
	});
});
