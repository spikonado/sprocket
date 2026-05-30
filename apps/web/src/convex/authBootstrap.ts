import { query } from '@convex/_generated/server';

export const getClientConfig = query({
	args: {},
	handler: async () => {
		return {
			workosClientId: process.env.WORKOS_CLIENT_ID ?? null
		};
	}
});
