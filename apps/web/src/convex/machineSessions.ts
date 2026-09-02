import { mutation, query } from '@convex/_generated/server';
import { v } from 'convex/values';
import { unsupportedClient } from '@convex/lib/unsupportedClient';

/** Retired process-session API. Current clients call `machines`. */

export const listMine = query({
	args: {},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const register = mutation({
	args: {
		installationId: v.string(),
		processSessionId: v.string(),
		credentialHash: v.string(),
		friendlyName: v.string(),
		platform: v.string(),
		platformVersion: v.optional(v.string()),
		architecture: v.string(),
		hostname: v.optional(v.string()),
		appVersion: v.string()
	},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const heartbeat = mutation({
	args: { sessionId: v.string(), credential: v.string() },
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});

export const end = mutation({
	args: { sessionId: v.string(), credential: v.string() },
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});
