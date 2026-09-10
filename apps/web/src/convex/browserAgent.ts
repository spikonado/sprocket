'use node';

import { v } from 'convex/values';
import { action } from '@convex/_generated/server';
import { unsupportedClient } from '@convex/lib/unsupportedClient';
import { vBrowserScreenshotResult, vBrowserTaskResult } from '@convex/lib/validators';

const browserArgs = {
	runId: v.id('runs'),
	claimId: v.string(),
	executionSecret: v.string()
};

/** Retired blocking browser action. Current agents use the Firecrawl request subscription. */
export const interact = action({
	args: { ...browserArgs, command: v.string(), enforce_saving: v.optional(v.boolean()) },
	returns: vBrowserTaskResult,
	handler: async () => {
		unsupportedClient();
	}
});

/** Retired blocking screenshot action. Current agents use the Firecrawl request subscription. */
export const screenshot = action({
	args: browserArgs,
	returns: vBrowserScreenshotResult,
	handler: async () => {
		unsupportedClient();
	}
});
