import { describe, expect, it } from 'vitest';
import { api } from '@convex/_generated/api';
import { UNSUPPORTED_CLIENT_MESSAGE } from '@convex/lib/unsupportedClient';
import { initConvexTest, seedOwnedThread } from './test.setup';

describe('messages transcript queries', () => {
	it('rejects older transcript list queries', async () => {
		const t = initConvexTest();
		const { asUser, threadId } = await seedOwnedThread(t);

		await expect(asUser.query(api.messages.listHistoryForThread, { threadId })).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
		await expect(asUser.query(api.messages.listLiveForThread, { threadId })).rejects.toThrow(
			UNSUPPORTED_CLIENT_MESSAGE
		);
	});
});
