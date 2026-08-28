import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { unsupportedClient } from '@convex/lib/unsupportedClient';

/** Retired cloud project catalog. Kept so older UIs get an update message. */

export const listMine = query({
	args: {},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const upsertSelected = mutation({
	args: {
		repositoryKey: v.string(),
		displayName: v.string(),
		connectedClientId: v.string()
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const heartbeatAttached = mutation({
	args: {
		projectId: v.string(),
		clientId: v.string()
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});
