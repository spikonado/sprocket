import { v } from 'convex/values';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { query } from './_generated/server';

/** Retired static catalog. Kept so older UIs get an update message. */
export const get = query({
	args: {},
	returns: v.null(),
	handler: async () => {
		unsupportedClient();
	}
});
