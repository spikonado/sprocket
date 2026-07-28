import { query } from '@convex/_generated/server';
import { v } from 'convex/values';

export const getClientConfig = query({
	args: {},
	returns: v.object({
		workosClientId: v.union(v.string(), v.null())
	}),
	handler: () => {
		return {
			workosClientId: process.env.WORKOS_CLIENT_ID ?? null
		};
	}
});
