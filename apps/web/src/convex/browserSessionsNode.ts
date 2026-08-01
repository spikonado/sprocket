'use node';

import { v, type Infer } from 'convex/values';
import { internalAction, type ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import Browserbase from '@browserbasehq/sdk';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { vBrowserSessionResult } from '@convex/lib/validators';

function browserbase(): { client: Browserbase; projectId: string } {
	const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
	if (!apiKey) throw new Error('BROWSERBASE_API_KEY is not configured.');
	const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
	if (!projectId) throw new Error('BROWSERBASE_PROJECT_ID is not configured.');
	return { client: new Browserbase({ apiKey }), projectId };
}

async function activeActor(
	ctx: ActionCtx,
	args: { runId: Doc<'runs'>['_id']; claimId: string; executionSecret: string }
) {
	const actor = await ctx.runQuery(api.agentRuntime.completionActor, {
		runId: args.runId,
		executionSecret: args.executionSecret
	});
	if (actor.claimId !== args.claimId || !isRunClaimLeaseActive(actor, Date.now())) {
		throw new Error('Run is no longer active.');
	}
	return actor;
}

export const startInternal = internalAction({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vBrowserSessionResult,
	handler: async (ctx, args): Promise<Infer<typeof vBrowserSessionResult>> => {
		const actor = await activeActor(ctx, args);
		const { client: bb, projectId } = browserbase();
		type Existing = {
			_id: Doc<'browserSessions'>['_id'];
			browserbaseSessionId: string;
			liveViewUrl: string;
		};
		const existing: Existing | null = await ctx.runQuery(internal.browserSessions.getForRun, {
			runId: args.runId,
			userId: actor.userId
		});
		if (existing) {
			// Reuse only if the remote session is still alive; otherwise drop the
			// stale row and fall through to create a fresh one.
			try {
				const remote = await bb.sessions.retrieve(existing.browserbaseSessionId);
				if (remote.status === 'RUNNING' && remote.connectUrl) {
					return { connectUrl: remote.connectUrl, liveViewUrl: existing.liveViewUrl };
				}
			} catch {
				// Remote session is gone (404) or unreachable — recreate below.
			}
			await ctx.runMutation(internal.browserSessions.remove, { id: existing._id });
		}

		const session = await bb.sessions.create({ projectId, keepAlive: true });
		const liveUrls = await bb.sessions.debug(session.id);
		await ctx.runMutation(internal.browserSessions.insert, {
			runId: args.runId,
			userId: actor.userId,
			browserbaseSessionId: session.id,
			liveViewUrl: liveUrls.debuggerFullscreenUrl
		});
		return {
			connectUrl: session.connectUrl,
			liveViewUrl: liveUrls.debuggerFullscreenUrl
		};
	}
});
