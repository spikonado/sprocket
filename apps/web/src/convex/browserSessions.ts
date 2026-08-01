import { v, type Infer } from 'convex/values';
import { action, internalMutation, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { api, internal } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import { vBrowserSessionResult } from '@convex/lib/validators';

const BROWSERBASE_API_URL = 'https://api.browserbase.com';

function browserbaseConfig(): { apiKey: string; projectId: string } {
	const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
	if (!apiKey) throw new Error('BROWSERBASE_API_KEY is not configured.');
	const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
	if (!projectId) throw new Error('BROWSERBASE_PROJECT_ID is not configured.');
	return { apiKey, projectId };
}

async function browserbaseRequest<T>(apiKey: string, path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${BROWSERBASE_API_URL}${path}`, {
		...init,
		headers: {
			'X-BB-API-Key': apiKey,
			...(init?.body ? { 'Content-Type': 'application/json' } : {}),
			...init?.headers
		}
	});
	if (!response.ok) {
		const details = await response.text();
		throw new Error(
			`Browserbase request failed (${response.status})${details ? `: ${details}` : '.'}`
		);
	}
	return (await response.json()) as T;
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

function connectUrl(apiKey: string, sessionId: string): string {
	const url = new URL('wss://connect.browserbase.com/');
	url.searchParams.set('apiKey', apiKey);
	url.searchParams.set('sessionId', sessionId);
	return url.toString();
}

const browserSessionDoc = v.object({
	_id: v.id('browserSessions'),
	_creationTime: v.number(),
	runId: v.id('runs'),
	userId: v.string(),
	browserbaseSessionId: v.string(),
	liveViewUrl: v.string(),
	startedAt: v.number()
});

export const getForRun = internalQuery({
	args: { runId: v.id('runs'), userId: v.string() },
	returns: v.union(browserSessionDoc, v.null()),
	handler: async (ctx, args) => {
		const session = await ctx.db
			.query('browserSessions')
			.withIndex('by_run', (query) => query.eq('runId', args.runId))
			.first();
		return session?.userId === args.userId ? session : null;
	}
});

export const insert = internalMutation({
	args: {
		runId: v.id('runs'),
		userId: v.string(),
		browserbaseSessionId: v.string(),
		liveViewUrl: v.string()
	},
	returns: v.id('browserSessions'),
	handler: async (ctx, args) => {
		return await ctx.db.insert('browserSessions', {
			...args,
			startedAt: Date.now()
		});
	}
});

export const start = action({
	args: {
		runId: v.id('runs'),
		claimId: v.string(),
		executionSecret: v.string()
	},
	returns: vBrowserSessionResult,
	handler: async (ctx, args): Promise<Infer<typeof vBrowserSessionResult>> => {
		const actor = await activeActor(ctx, args);
		const { apiKey, projectId } = browserbaseConfig();
		const existing: { browserbaseSessionId: string; liveViewUrl: string } | null =
			await ctx.runQuery(internal.browserSessions.getForRun, {
				runId: args.runId,
				userId: actor.userId
			});
		if (existing) {
			await browserbaseRequest(
				apiKey,
				`/v1/sessions/${encodeURIComponent(existing.browserbaseSessionId)}`
			);
			return {
				connectUrl: connectUrl(apiKey, existing.browserbaseSessionId),
				liveViewUrl: existing.liveViewUrl
			};
		}

		const session = await browserbaseRequest<{ id: string; connectUrl: string }>(
			apiKey,
			'/v1/sessions',
			{
				method: 'POST',
				body: JSON.stringify({ projectId, keepAlive: true })
			}
		);
		const liveUrls = await browserbaseRequest<{ debuggerFullscreenUrl: string }>(
			apiKey,
			`/v1/sessions/${encodeURIComponent(session.id)}/debug`
		);
		await ctx.runMutation(internal.browserSessions.insert, {
			runId: args.runId,
			userId: actor.userId,
			browserbaseSessionId: session.id,
			liveViewUrl: liveUrls.debuggerFullscreenUrl
		});
		return {
			connectUrl: session.connectUrl || connectUrl(apiKey, session.id),
			liveViewUrl: liveUrls.debuggerFullscreenUrl
		};
	}
});
