'use node';

import { v, type Infer } from 'convex/values';
import { action } from '@convex/_generated/server';
import { runFirecrawlRequest } from '@convex/lib/firecrawlQueue';
import { vBrowserScreenshotResult, vBrowserTaskResult } from '@convex/lib/validators';

const browserArgs = {
	runId: v.id('runs'),
	claimId: v.string(),
	executionSecret: v.string()
};

export const interact = action({
	args: { ...browserArgs, command: v.string(), enforce_saving: v.optional(v.boolean()) },
	returns: vBrowserTaskResult,
	handler: (ctx, args): Promise<Infer<typeof vBrowserTaskResult>> =>
		runFirecrawlRequest(ctx, { ...args, kind: 'browser_interact' }, vBrowserTaskResult)
});

export const screenshot = action({
	args: browserArgs,
	returns: vBrowserScreenshotResult,
	handler: (ctx, args): Promise<Infer<typeof vBrowserScreenshotResult>> =>
		runFirecrawlRequest(ctx, { ...args, kind: 'browser_screenshot' }, vBrowserScreenshotResult)
});
