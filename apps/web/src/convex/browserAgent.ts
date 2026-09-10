'use node';

import { v } from 'convex/values';
import { action } from '@convex/_generated/server';
import {
	interact as firecrawlInteract,
	screenshot as firecrawlScreenshot
} from '@convex/firecrawlBrowser';
import { vBrowserScreenshotResult, vBrowserTaskResult } from '@convex/lib/validators';

const browserArgs = {
	runId: v.id('runs'),
	claimId: v.string(),
	executionSecret: v.string()
};

export const interact = action({
	args: { ...browserArgs, command: v.string(), enforce_saving: v.optional(v.boolean()) },
	returns: vBrowserTaskResult,
	handler: firecrawlInteract
});

export const screenshot = action({
	args: browserArgs,
	returns: vBrowserScreenshotResult,
	handler: firecrawlScreenshot
});
