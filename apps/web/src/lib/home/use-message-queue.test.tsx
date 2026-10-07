import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { AgentRunRequest } from '$lib/types/sprocket';
import type { Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import { useMessageQueue } from './use-message-queue';

afterEach(cleanup);

function request(submissionId: string): AgentRunRequest {
	return {
		userId: 'user-a',
		// SAFETY: the client fixture treats document ids as opaque strings.
		threadId: 'thread-a' as Id<'threadRecords'>,
		submissionId,
		executionSecret: `secret-${submissionId}`,
		workspacePath: '/workspace',
		prompt: 'Build it',
		storageIds: [],
		selectedModel: 'model-a',
		completionProvider: 'openai',
		reasoningEffort: 'high',
		fastMode: false
	};
}

function fixture() {
	const client = new ConvexTestClient();
	client.registerQuery(api.messageQueue.list, []);
	const enqueueMessage = vi.fn<(request: AgentRunRequest) => Promise<void>>(async () => {});

	const wrapper = ({ children }: PropsWithChildren) => (
		<ConvexTestProvider client={client}>{children}</ConvexTestProvider>
	);

	const hook = renderHook(
		() =>
			useMessageQueue({
				client,
				desktopApi: { enqueueMessage },
				userId: 'user-a',
				onError: vi.fn()
			}),
		{ wrapper }
	);

	return { ...hook, client, enqueueMessage };
}

describe('useMessageQueue', () => {
	it('waits for durable acknowledgement and recovers a lost response with the original capability', async () => {
		const { result, enqueueMessage } = fixture();
		await waitFor(() => expect(result.current.isLoaded).toBe(true));
		const ack = Promise.withResolvers<void>();
		enqueueMessage.mockImplementationOnce(() => ack.promise);
		const first = request('first');
		let pending: Promise<void>;
		act(() => {
			pending = result.current.queue.enqueue(first);
		});
		expect(result.current.queue.hasPendingSubmission(first)).toBe(true);
		expect(result.current.messages).toEqual([]);
		ack.reject(new Error('Response lost'));
		await expect(pending!).rejects.toThrow('Response lost');
		expect(result.current.queue.hasPendingSubmission(request('new-id'))).toBe(true);
		await act(() => result.current.queue.enqueue(request('new-id')));
		expect(enqueueMessage.mock.calls.map(([args]) => args.submissionId)).toEqual([
			'first',
			'first'
		]);
		expect(enqueueMessage.mock.calls.map(([args]) => args.executionSecret)).toEqual([
			'secret-first',
			'secret-first'
		]);
		expect(result.current.queue.hasPendingSubmission(first)).toBe(false);
	});

	it('restores messages from the backend after remounting and never launches runs in React', async () => {
		const { result, client, enqueueMessage, unmount } = fixture();

		const saved = [
			{
				id: 'persisted',
				userId: 'user-a',
				threadId: request('persisted').threadId!,
				prompt: 'Saved prompt',
				attachmentNames: ['board.png'],
				status: 'sending' as const,
				error: undefined
			}
		];

		act(() => client.registerQuery(api.messageQueue.list, saved));
		await waitFor(() => expect(result.current.messages).toEqual(saved));
		unmount();

		const wrapper = ({ children }: PropsWithChildren) => (
			<ConvexTestProvider client={client}>{children}</ConvexTestProvider>
		);

		const restored = renderHook(
			() =>
				useMessageQueue({
					client,
					desktopApi: { enqueueMessage },
					userId: 'user-a',
					onError: vi.fn()
				}),
			{ wrapper }
		);

		await waitFor(() => expect(restored.result.current.messages).toEqual(saved));
		expect(enqueueMessage).not.toHaveBeenCalled();
	});
});
