import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { UNSUPPORTED_CLIENT_MESSAGE } from '@convex/lib/unsupportedClient';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('retired client APIs', () => {
	it('tell older clients to update Sprocket', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await expect(
			asUser.mutation(api.agentRuntime.createRun, {
				submissionId: 'old-create',
				threadId,
				prompt: 'Hello',
				imageUploadIds: [],
				selectedModel: 'gpt-5.6-sol',
				reasoningEffort: 'medium',
				serviceTier: 'standard',
				executionSecret: 'old-secret'
			})
		).rejects.toThrow(UNSUPPORTED_CLIENT_MESSAGE);

		await expect(asUser.mutation(api.uiPreferences.setLastThread, { threadId })).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);

		await expect(
			asUser.mutation(api.uiPreferences.setPaymentsEmail, { email: 'old@example.com' })
		).rejects.toThrow(UNSUPPORTED_CLIENT_MESSAGE);

		await expect(asUser.action(api.completion.complete, {})).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);

		await expect(asUser.query(api.projects.listMine, {})).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);

		await expect(asUser.mutation(api.agentRuntime.mergeAssistantStreamEvents, {})).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
	});
});
