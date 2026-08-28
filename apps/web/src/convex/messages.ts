import { query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { unsupportedClient } from '@convex/lib/unsupportedClient';

/** Retired Convex transcript queries. Kept so older UIs get an update message. */
export const listHistoryForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const listLiveForThread = query({
	args: {
		threadId: v.id('threadRecords')
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});
