import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { UNSUPPORTED_CLIENT_MESSAGE } from '@convex/lib/unsupportedClient';
import { createQueuedRun, initConvexTest, seedOwnedThread } from './test.setup';

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

		await expect(asUser.query(api.threads.listMine, {})).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
		await expect(
			asUser.mutation(api.machineSessions.register, {
				installationId: 'old',
				processSessionId: 'old',
				credentialHash: 'a'.repeat(64),
				friendlyName: 'Old',
				platform: 'linux',
				architecture: 'x86_64',
				appVersion: '0.1.0'
			})
		).rejects.toThrow(UNSUPPORTED_CLIENT_MESSAGE);
		await expect(asUser.query(api.chat.latestRunForThread, { threadId })).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
		const { runId } = await createQueuedRun(t, asUser, threadId, 'old-reopen', 'old-reopen-secret');
		await expect(asUser.mutation(api.agentRuntime.reopenRun, { runId })).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
		await expect(
			asUser.mutation(api.threads.rename, { threadId, title: 'Old client' })
		).rejects.toThrow(UNSUPPORTED_CLIENT_MESSAGE);
		await expect(asUser.mutation(api.threads.archive, { threadId })).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
		await expect(asUser.mutation(api.threads.restore, { threadId })).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
		await expect(
			asUser.mutation(api.threads.rekeyRepository, { from: 'old', to: 'new' })
		).rejects.toThrow(UNSUPPORTED_CLIENT_MESSAGE);

		await expect(asUser.mutation(api.agentRuntime.mergeAssistantStreamEvents, {})).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
	});
});
