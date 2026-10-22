import { v, type Infer } from 'convex/values';
import { internal } from '@convex/_generated/api';
import { env, type MutationCtx } from '@convex/_generated/server';
import { vJsonValue } from '@convex/lib/json';

export const vAnalyticsEvent = v.object({
	distinctId: v.string(),
	event: v.string(),
	properties: v.record(v.string(), vJsonValue),
	// Convex field names can't start with `$`, so `send` maps this to `$set`.
	personProperties: v.optional(v.record(v.string(), v.string()))
});

export function analyticsEnabled(): boolean {
	return Boolean(env.POSTHOG_PROJECT_TOKEN);
}

export async function captureEvent(
	ctx: MutationCtx,
	event: Infer<typeof vAnalyticsEvent>
): Promise<void> {
	if (!analyticsEnabled()) return;

	await ctx.scheduler.runAfter(0, internal.analytics.send, {
		...event,
		timestamp: new Date().toISOString()
	});
}
