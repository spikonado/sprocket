'use node';

import { v, type Infer } from 'convex/values';
import { action, type ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { Stagehand } from '@browserbasehq/stagehand';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { vBrowserTaskResult } from '@convex/lib/validators';

const DEFAULT_MODEL = 'openai/gpt-5-mini';
// Bounds the text returned to the main agent so a runaway page can't flood the
// transcript.
const MAX_RESULT_CHARS = 8_000;

function browserbaseConfig(): { apiKey: string; projectId: string; model: string } {
	const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
	if (!apiKey) throw new Error('BROWSERBASE_API_KEY is not configured.');
	const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
	if (!projectId) throw new Error('BROWSERBASE_PROJECT_ID is not configured.');
	return { apiKey, projectId, model: process.env.BROWSER_TASK_MODEL?.trim() || DEFAULT_MODEL };
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

function clip(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
	return { text: `${text.slice(0, MAX_RESULT_CHARS)}\n[... truncated ...]`, truncated: true };
}

export const runTask = action({
	args: {
		instruction: v.string(),
		startUrl: v.optional(v.string()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vBrowserTaskResult,
	handler: async (ctx, args): Promise<Infer<typeof vBrowserTaskResult>> => {
		const actor = await activeActor(ctx, args);
		const { apiKey, projectId, model } = browserbaseConfig();

		// Attach to the run's existing Browserbase session (created by
		// browserSessions.start, also used by the executor's fill_payment), or
		// create one on first use.
		const existing: { browserbaseSessionId: string } | null = await ctx.runQuery(
			internal.browserSessions.getForRun,
			{ runId: args.runId, userId: actor.userId }
		);

		const stagehand = new Stagehand({
			env: 'BROWSERBASE',
			apiKey,
			projectId,
			model,
			selfHeal: true,
			keepAlive: true,
			...(existing ? { browserbaseSessionID: existing.browserbaseSessionId } : {})
		});
		try {
			await stagehand.init();
			// Persist the session id so the executor's fill_payment attaches to the
			// same browser on first use.
			if (!existing) {
				const sessionId = stagehand.browserbaseSessionId;
				if (sessionId) {
					await ctx.runMutation(internal.browserSessions.insert, {
						runId: args.runId,
						userId: actor.userId,
						browserbaseSessionId: sessionId,
						liveViewUrl: ''
					});
				}
			}
			if (args.startUrl) {
				await stagehand.context.pages()[0]?.goto(args.startUrl);
			}
			const result = await stagehand.act(args.instruction);
			const summary = `success: ${result.success}\n${result.message ?? ''}`.trim();
			const { text, truncated } = clip(summary);
			return { text, truncated };
		} finally {
			await stagehand.close().catch(() => {});
		}
	}
});
