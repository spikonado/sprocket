import { useRef } from 'react';
import { useQuery, type ConvexReactClient } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { AgentRunRequest, DesktopApi } from '$lib/types/sprocket';

export function useMessageQueue({
	client,
	desktopApi,
	userId,
	onError
}: {
	client: ConvexReactClient;
	desktopApi: Pick<DesktopApi, 'enqueueMessage'> | null;
	userId: string | null;
	onError: (error: string) => void;
}) {
	const messages = useQuery(api.messageQueue.list, userId ? {} : 'skip');
	const pending = useRef(new Map<string, AgentRunRequest>());

	return {
		isLoaded: messages !== undefined,
		messages: messages ?? [],
		queue: {
			hasPendingSubmission: (request: AgentRunRequest) =>
				pending.current.has(submissionKey(request)),
			enqueue: async (request: AgentRunRequest) => {
				if (!desktopApi || request.userId !== userId) throw new Error('User session is not ready.');
				// Preserve the submission capability if the durable enqueue committed
				// but its HTTP response was lost and the unchanged draft is retried.
				const key = submissionKey(request);
				const submission = pending.current.get(key) ?? request;
				pending.current.set(key, submission);
				await desktopApi.enqueueMessage(submission);
				pending.current.delete(key);
			},
			retry: (id: string) => {
				void client.mutation(api.messageQueue.retry, { submissionId: id }).catch((error) => {
					onError(error instanceof Error ? error.message : 'Failed to retry queued message.');
				});
			},
			remove: (id: string) => {
				void client.mutation(api.messageQueue.remove, { submissionId: id }).catch((error) => {
					onError(error instanceof Error ? error.message : 'Failed to remove queued message.');
				});
			}
		}
	};
}

function submissionKey(request: AgentRunRequest) {
	return JSON.stringify([
		request.userId,
		request.threadId,
		request.workspacePath,
		request.prompt,
		request.storageIds,
		request.selectedModel,
		request.completionProvider,
		request.reasoningEffort,
		request.fastMode
	]);
}
