'use node';

import { v, type Infer } from 'convex/values';
import { action, type ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { Stagehand } from '@browserbasehq/stagehand';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import {
	vBrowserObservedAction,
	vBrowserObserveResult,
	vBrowserTaskResult
} from '@convex/lib/validators';

// The browsing sub-agent's model. Uses the same OpenAI key as the main agent.
const DEFAULT_MODEL = 'openai/gpt-5.6-sol';
// Bounds text returned to the main agent so a runaway page can't flood the transcript.
const MAX_RESULT_CHARS = 8_000;
// Bound the structured actions array itself, not just its text mirror — a
// hostile or complex page can make Stagehand return thousands of actions.
const MAX_OBSERVE_ACTIONS = 50;

function config() {
	const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
	if (!apiKey) throw new Error('BROWSERBASE_API_KEY is not configured.');
	const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
	if (!projectId) throw new Error('BROWSERBASE_PROJECT_ID is not configured.');
	const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
	if (!openaiApiKey) throw new Error('OPENAI_API_KEY is not configured.');
	return {
		apiKey,
		projectId,
		model: {
			modelName: process.env.BROWSER_TASK_MODEL?.trim() || DEFAULT_MODEL,
			apiKey: openaiApiKey
		}
	};
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

/** Trim observed actions to a count and serialized-size budget so the result
 * can't flood the executor/model transcript. truncated is set whenever any
 * action is dropped. */
function boundActions<T>(actions: T[]): { actions: T[]; truncated: boolean } {
	const kept: T[] = [];
	let size = 0;
	for (const action of actions) {
		if (kept.length >= MAX_OBSERVE_ACTIONS) {
			return { actions: kept, truncated: true };
		}
		size += JSON.stringify(action).length;
		if (size > MAX_RESULT_CHARS) {
			return { actions: kept, truncated: true };
		}
		kept.push(action);
	}
	return { actions: kept, truncated: false };
}

// Browserbase hard-stops a session when its `timeout` elapses, regardless of
// activity. Give thread sessions an hour and rotate a little early.
const SESSION_TIMEOUT_SECONDS = 3600;
const SESSION_REUSE_MS = 55 * 60 * 1000;

type StagehandConfig = ReturnType<typeof config>;

/** Fetch the embeddable live view URL for a running session. Best effort:
 * the browser tool call must not fail because observability did; a missing
 * URL is backfilled on a later call. */
async function fetchLiveViewUrl(apiKey: string, sessionId: string): Promise<string | null> {
	try {
		const response = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/debug`, {
			headers: { 'x-bb-api-key': apiKey },
			// Bound the wait so a stalled endpoint can't hold up the tool call.
			signal: AbortSignal.timeout(5_000)
		});
		if (!response.ok) return null;
		const urls: { debuggerFullscreenUrl?: unknown } = await response.json();
		return typeof urls.debuggerFullscreenUrl === 'string' ? urls.debuggerFullscreenUrl : null;
	} catch {
		return null;
	}
}

/** Start a Stagehand on Browserbase, resuming `browserbaseSessionID` when
 * given. Returns null when a resume fails (dead session) so the caller can
 * fall back to a fresh one; failures of a fresh session throw. */
async function startStagehand(
	{ apiKey, projectId, model }: StagehandConfig,
	browserbaseSessionID?: string
): Promise<Stagehand | null> {
	const stagehand = new Stagehand({
		env: 'BROWSERBASE',
		apiKey,
		projectId,
		model,
		selfHeal: true,
		keepAlive: true,
		// Convex actions can't spawn pino's transport worker, which the
		// default pretty-printing logger needs — it fails to resolve
		// pino-pretty and crashes Stagehand construction.
		disablePino: true,
		browserbaseSessionCreateParams: { keepAlive: true, timeout: SESSION_TIMEOUT_SECONDS },
		...(browserbaseSessionID ? { browserbaseSessionID } : {})
	});
	try {
		await stagehand.init();
		return stagehand;
	} catch (error) {
		await stagehand.close().catch(() => {});
		if (browserbaseSessionID) return null;
		throw error;
	}
}

/** Attach a Stagehand to the thread's shared Browserbase session, creating or
 * rotating it as needed. All runs and tool calls in a thread share one
 * session so the agent keeps its page state between turns. */
async function attachStagehand(
	ctx: ActionCtx,
	userId: string,
	runId: Doc<'runs'>['_id'],
	threadId: Doc<'threadRecords'>['_id']
): Promise<Stagehand> {
	const cfg = config();
	const existing = await ctx.runQuery(internal.browserSessions.getForThread, {
		threadId,
		userId
	});
	const reusable = existing && Date.now() - existing.startedAt < SESSION_REUSE_MS ? existing : null;

	let stagehand = reusable ? await startStagehand(cfg, reusable.browserbaseSessionId) : null;
	stagehand ??= await startStagehand(cfg);
	if (!stagehand) {
		throw new Error('Failed to start a browser session.');
	}

	const browserbaseSessionId = stagehand.browserbaseSessionId;
	if (!browserbaseSessionId) {
		await stagehand.close().catch(() => {});
		throw new Error('Stagehand did not report a Browserbase session id.');
	}
	if (browserbaseSessionId !== reusable?.browserbaseSessionId) {
		const liveViewUrl = await fetchLiveViewUrl(cfg.apiKey, browserbaseSessionId);
		await ctx.runMutation(internal.browserSessions.upsertForThread, {
			threadId,
			runId,
			userId,
			browserbaseSessionId,
			...(liveViewUrl ? { liveViewUrl } : {})
		});
	} else if (existing) {
		if (!existing.liveViewUrl) {
			const liveViewUrl = await fetchLiveViewUrl(cfg.apiKey, browserbaseSessionId);
			if (liveViewUrl) {
				await ctx.runMutation(internal.browserSessions.setLiveViewUrl, {
					threadId,
					browserbaseSessionId,
					liveViewUrl
				});
			}
		}
		await ctx.runMutation(internal.browserSessions.touchForThread, {
			threadId,
			runId
		});
	}
	return stagehand;
}

async function gotoIfProvided(stagehand: Stagehand, startUrl?: string): Promise<void> {
	if (startUrl) {
		await stagehand.context.pages()[0]?.goto(startUrl);
	}
}

export const act = action({
	args: {
		instruction: v.optional(v.string()),
		action: v.optional(vBrowserObservedAction),
		startUrl: v.optional(v.string()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vBrowserTaskResult,
	handler: async (ctx, args): Promise<Infer<typeof vBrowserTaskResult>> => {
		const actor = await activeActor(ctx, args);
		const stagehand = await attachStagehand(ctx, actor.userId, args.runId, actor.threadId);
		try {
			await gotoIfProvided(stagehand, args.startUrl);
			if (!args.instruction && !args.action) {
				throw new Error('browser_act needs an instruction or an action.');
			}
			const result = args.action
				? await stagehand.act(args.action)
				: await stagehand.act(args.instruction!);
			return clip(`success: ${result.success}\n${result.message}`.trim());
		} finally {
			await stagehand.close().catch(() => {});
		}
	}
});

export const observe = action({
	args: {
		instruction: v.string(),
		startUrl: v.optional(v.string()),
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vBrowserObserveResult,
	handler: async (ctx, args) => {
		const actor = await activeActor(ctx, args);
		const stagehand = await attachStagehand(ctx, actor.userId, args.runId, actor.threadId);
		try {
			await gotoIfProvided(stagehand, args.startUrl);
			const actions = await stagehand.observe(args.instruction);
			const bounded = boundActions(actions);
			const clipped = clip(JSON.stringify(bounded.actions));
			return {
				actions: bounded.actions,
				text: clipped.text,
				truncated: bounded.truncated || clipped.truncated
			};
		} finally {
			await stagehand.close().catch(() => {});
		}
	}
});

export const extract = action({
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
		const stagehand = await attachStagehand(ctx, actor.userId, args.runId, actor.threadId);
		try {
			await gotoIfProvided(stagehand, args.startUrl);
			const result = await stagehand.extract(args.instruction);
			return clip(JSON.stringify(result));
		} finally {
			await stagehand.close().catch(() => {});
		}
	}
});
