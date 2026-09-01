'use node';

import { v, type Infer } from 'convex/values';
import { action, env, type ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import {
	browserbase,
	Stagehand,
	type ModelName,
	type StagehandBrowser
} from '@browserbasehq/stagehand';
import { z } from 'zod';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import {
	vBrowserObservedAction,
	vBrowserObserveResult,
	vBrowserTaskResult
} from '@convex/lib/validators';
import { toAgentToolConvexError } from '@convex/lib/agentErrors';

// The browsing sub-agent's model. Uses the same OpenAI key as the main agent.
const DEFAULT_MODEL = 'openai/gpt-5.6-sol';
// Bounds text returned to the main agent so a runaway page can't flood the transcript.
const MAX_RESULT_CHARS = 8_000;
// Bound the structured actions array itself, not just its text mirror. A
// hostile or complex page can make Stagehand return thousands of actions.
const MAX_OBSERVE_ACTIONS = 50;

type BrowserModel = {
	modelName: ModelName;
	apiKey: string;
};

type BrowserAgentConfig = {
	apiKey: string;
	projectId?: string;
	model: BrowserModel;
};

function config(): BrowserAgentConfig {
	const apiKey = env.BROWSERBASE_API_KEY?.trim();
	if (!apiKey) throw new Error('BROWSERBASE_API_KEY is not configured.');
	const openaiApiKey = env.OPENAI_API_KEY?.trim();
	if (!openaiApiKey) throw new Error('OPENAI_API_KEY is not configured.');
	const projectId = env.BROWSERBASE_PROJECT_ID?.trim();
	const modelName = env.BROWSER_TASK_MODEL?.trim() || DEFAULT_MODEL;
	const resolved: BrowserAgentConfig = {
		apiKey,
		model: {
			// SAFETY: BROWSER_TASK_MODEL is an operator-selected Stagehand
			// provider/model id; Stagehand rejects unknown names at session start.
			modelName: modelName as ModelName,
			apiKey: openaiApiKey
		}
	};
	if (projectId) resolved.projectId = projectId;
	return resolved;
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

type ClippedText = {
	text: string;
	truncated: boolean;
};

function clip(text: string): ClippedText {
	if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
	return { text: `${text.slice(0, MAX_RESULT_CHARS)}\n[... truncated ...]`, truncated: true };
}

/** Trim observed actions to a count and serialized-size budget so the result
 * can't flood the executor/model transcript. truncated is set whenever any
 * action is dropped. */
type BoundedActions<T> = {
	actions: T[];
	truncated: boolean;
};

function boundActions<T>(actions: T[]): BoundedActions<T> {
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

type ObservedAction = Infer<typeof vBrowserObservedAction>;
type StagehandClient = Pick<Stagehand, 'act' | 'observe' | 'extract'>;
type ActResult = Awaited<ReturnType<StagehandClient['act']>>;
type ObserveResult = Awaited<ReturnType<StagehandClient['observe']>>;
type ExtractResult = Awaited<ReturnType<StagehandClient['extract']>>;

type BrowserSessionLaunch = {
	apiKey: string;
	projectId?: string;
	model: BrowserModel;
	keepAlive: boolean;
	timeout: number;
	sessionId?: string;
};

export type BrowserSessionHandle = {
	sessionId: string;
	act: StagehandClient['act'];
	observe: StagehandClient['observe'];
	extract: StagehandClient['extract'];
	goto: (url: string) => Promise<void>;
	close: () => Promise<void>;
};

type BrowserSessionFactory = (
	options: BrowserSessionLaunch
) => Promise<BrowserSessionHandle | null>;

type BrowserSessionFactorySlot = typeof globalThis & {
	__sprocketCreateBrowserSession?: BrowserSessionFactory;
};

type BrowserSessionUpsert = {
	threadId: Doc<'threadRecords'>['_id'];
	runId: Doc<'runs'>['_id'];
	userId: string;
	browserbaseSessionId: string;
	liveViewUrl?: string;
};

// SAFETY: only test suites assign __sprocketCreateBrowserSession on globalThis; production never writes this slot.
const sessionFactorySlot = globalThis as BrowserSessionFactorySlot;

function actSummary(result: ActResult): string {
	return `success: ${result.data.success}\n${result.data.message}`.trim();
}

function observeActions(result: ObserveResult): ObservedAction[] {
	return result.data;
}

function extractPayload(result: ExtractResult): string {
	return JSON.stringify(result.data);
}

async function gotoOnBrowser(browser: StagehandBrowser, url: string): Promise<void> {
	const page = (await browser.context.activePage()) ?? (await browser.context.pages())[0];
	if (page) {
		await page.goto(url);
		return;
	}
	await browser.context.newPage(url);
}

async function launchBrowserbase(options: BrowserSessionLaunch): Promise<StagehandBrowser> {
	const launch = {
		apiKey: options.apiKey,
		keepAlive: options.keepAlive,
		// Browserbase session duration. The SDK field is `api_timeout`; it is
		// serialized as `timeout` on the Sessions API.
		api_timeout: options.timeout
	};
	if (options.projectId) {
		return await browserbase.launch({ ...launch, projectId: options.projectId });
	}
	return await browserbase.launch(launch);
}

async function createProductionSession(
	options: BrowserSessionLaunch
): Promise<BrowserSessionHandle | null> {
	const browser = options.sessionId
		? await browserbase.connect({ apiKey: options.apiKey, sessionId: options.sessionId })
		: await launchBrowserbase(options);
	try {
		const stagehand = await Stagehand.create({
			browser,
			apiKey: options.apiKey,
			model: options.model,
			selfHeal: true,
			cache: true,
			logging: { level: 'off' }
		});
		const sessionId = browser.sessionId;
		if (!sessionId) {
			await stagehand.close().catch(() => {});
			await browser.close().catch(() => {});
			if (options.sessionId) return null;
			throw new Error('Browserbase did not report a session id.');
		}
		return {
			sessionId,
			act: stagehand.act.bind(stagehand),
			observe: stagehand.observe.bind(stagehand),
			extract: stagehand.extract.bind(stagehand),
			goto: (url) => gotoOnBrowser(browser, url),
			close: async () => {
				await stagehand.close().catch(() => {});
				// keepAlive sessions stay running after this; close() only
				// drops the CDP connection so the next tool call can reconnect.
				await browser.close().catch(() => {});
			}
		};
	} catch (error) {
		await browser.close().catch(() => {});
		if (options.sessionId) return null;
		throw error;
	}
}

async function createSession(options: BrowserSessionLaunch): Promise<BrowserSessionHandle | null> {
	const bound = sessionFactorySlot.__sprocketCreateBrowserSession;
	if (bound) return bound(options);
	return createProductionSession(options);
}

export function bindBrowserSessionFactory(factory: BrowserSessionFactory | undefined): () => void {
	const previous = sessionFactorySlot.__sprocketCreateBrowserSession;
	sessionFactorySlot.__sprocketCreateBrowserSession = factory;
	return () => {
		sessionFactorySlot.__sprocketCreateBrowserSession = previous;
	};
}

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
		const parsed = z.object({ debuggerFullscreenUrl: z.url() }).safeParse(await response.json());
		return parsed.success ? parsed.data.debuggerFullscreenUrl : null;
	} catch {
		return null;
	}
}

/** Start a Stagehand on Browserbase, resuming `sessionId` when given. Returns
 * null when a resume fails (dead session) so the caller can fall back to a
 * fresh one; failures of a fresh session throw. */
async function startSession(
	cfg: BrowserAgentConfig,
	sessionId?: string
): Promise<BrowserSessionHandle | null> {
	const options: BrowserSessionLaunch = {
		apiKey: cfg.apiKey,
		model: cfg.model,
		keepAlive: true,
		timeout: SESSION_TIMEOUT_SECONDS
	};
	if (cfg.projectId) options.projectId = cfg.projectId;
	if (sessionId) options.sessionId = sessionId;
	try {
		return await createSession(options);
	} catch (error) {
		if (sessionId) return null;
		throw error;
	}
}

/** Attach a Stagehand to the thread's shared Browserbase session, creating or
 * rotating it as needed. All runs and tool calls in a thread share one
 * session so the agent keeps its page state between turns. */
async function attachSession(
	ctx: ActionCtx,
	userId: string,
	runId: Doc<'runs'>['_id'],
	threadId: Doc<'threadRecords'>['_id']
): Promise<BrowserSessionHandle> {
	const cfg = config();
	const existing = await ctx.runQuery(internal.browserSessions.getForThread, {
		threadId,
		userId
	});
	const reusable = existing && Date.now() - existing.startedAt < SESSION_REUSE_MS ? existing : null;

	let session = reusable ? await startSession(cfg, reusable.browserbaseSessionId) : null;
	session ??= await startSession(cfg);
	if (!session) {
		throw new Error('Failed to start a browser session.');
	}

	if (session.sessionId !== reusable?.browserbaseSessionId) {
		const liveViewUrl = await fetchLiveViewUrl(cfg.apiKey, session.sessionId);
		const stored: BrowserSessionUpsert = {
			threadId,
			runId,
			userId,
			browserbaseSessionId: session.sessionId
		};
		if (liveViewUrl) stored.liveViewUrl = liveViewUrl;
		await ctx.runMutation(internal.browserSessions.upsertForThread, stored);
	} else if (existing) {
		if (!existing.liveViewUrl) {
			const liveViewUrl = await fetchLiveViewUrl(cfg.apiKey, session.sessionId);
			if (liveViewUrl) {
				await ctx.runMutation(internal.browserSessions.setLiveViewUrl, {
					threadId,
					browserbaseSessionId: session.sessionId,
					liveViewUrl
				});
			}
		}
		await ctx.runMutation(internal.browserSessions.touchForThread, {
			threadId,
			runId
		});
	}
	return session;
}

async function gotoIfProvided(session: BrowserSessionHandle, startUrl?: string): Promise<void> {
	if (startUrl) await session.goto(startUrl);
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
		try {
			const actor = await activeActor(ctx, args);
			const session = await attachSession(ctx, actor.userId, args.runId, actor.threadId);
			try {
				await gotoIfProvided(session, args.startUrl);
				if (!args.instruction && !args.action) {
					throw new Error('browser_act needs an instruction or an action.');
				}
				const result = args.action
					? await session.act(args.action)
					: await session.act(args.instruction!);
				return clip(actSummary(result));
			} finally {
				await session.close().catch(() => {});
			}
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
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
		try {
			const actor = await activeActor(ctx, args);
			const session = await attachSession(ctx, actor.userId, args.runId, actor.threadId);
			try {
				await gotoIfProvided(session, args.startUrl);
				const actions = observeActions(await session.observe(args.instruction));
				const bounded = boundActions(actions);
				const clipped = clip(JSON.stringify(bounded.actions));
				return {
					actions: bounded.actions,
					text: clipped.text,
					truncated: bounded.truncated || clipped.truncated
				};
			} finally {
				await session.close().catch(() => {});
			}
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
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
		try {
			const actor = await activeActor(ctx, args);
			const session = await attachSession(ctx, actor.userId, args.runId, actor.threadId);
			try {
				await gotoIfProvided(session, args.startUrl);
				return clip(extractPayload(await session.extract(args.instruction)));
			} finally {
				await session.close().catch(() => {});
			}
		} catch (error) {
			throw toAgentToolConvexError(error instanceof Error ? error : new Error(String(error)));
		}
	}
});
