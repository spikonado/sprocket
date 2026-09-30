import { env, query } from '@convex/_generated/server';
import { v } from 'convex/values';

export const getClientConfig = query({
	args: {},
	returns: v.object({
		workosClientId: v.string()
	}),
	handler: () => {
		return {
			workosClientId: env.WORKOS_CLIENT_ID
		};
	}
});
