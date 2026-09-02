import { mutation, query, type MutationCtx, type QueryCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { v } from 'convex/values';
import { constantTimeEqual, executionSecretHash, getUserId } from '@convex/lib/auth';
import { finalizeRunRecord } from '@convex/lib/runFinalize';

const SESSION_ENDED = 'The executor session ended before this run finished.';
const ONLINE_THRESHOLD_MS = 90_000;

export const listMine = query({
	args: {},
	returns: v.array(
		v.object({
			installationId: v.string(),
			friendlyName: v.string(),
			platform: v.string(),
			platformVersion: v.optional(v.string()),
			architecture: v.string(),
			hostname: v.optional(v.string()),
			appVersion: v.string(),
			lastSeenAt: v.optional(v.number()),
			online: v.boolean()
		})
	),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const now = Date.now();
		const installations = await ctx.db
			.query('installations')
			.withIndex('by_userId_and_installationId', (query) => query.eq('userId', userId))
			.collect();
		return await Promise.all(
			installations.map(async (installation) => {
				const session = installation.currentSessionId
					? await ctx.db.get('machineSessions', installation.currentSessionId)
					: null;
				const active = session?.revokedAt === undefined && session?.supersededAt === undefined;
				return {
					installationId: installation.installationId,
					friendlyName: installation.friendlyName,
					platform: installation.platform,
					platformVersion: installation.platformVersion,
					architecture: installation.architecture,
					hostname: installation.hostname,
					appVersion: installation.appVersion,
					lastSeenAt: session?.lastSeenAt,
					online: Boolean(active && session && now - session.lastSeenAt <= ONLINE_THRESHOLD_MS)
				};
			})
		);
	}
});

async function failSessionRuns(ctx: MutationCtx, session: Doc<'machineSessions'>): Promise<void> {
	const sessionRuns = await ctx.db
		.query('machineSessionRuns')
		.withIndex('by_sessionId_and_active', (query) =>
			query.eq('sessionId', session._id).eq('active', true)
		)
		.take(65);
	if (sessionRuns.length > 64) {
		throw new Error('Executor session has too many active runs to supersede safely.');
	}
	for (const sessionRun of sessionRuns) {
		const run = await ctx.db.get('runs', sessionRun.runId);
		if (run) {
			await finalizeRunRecord(ctx, run, {
				text: SESSION_ENDED,
				status: 'failed',
				lastError: SESSION_ENDED
			});
		} else {
			await ctx.db.patch('machineSessionRuns', sessionRun._id, { active: false });
		}
	}
}

async function requireProcessSession(
	ctx: QueryCtx | MutationCtx,
	sessionId: Doc<'machineSessions'>['_id'],
	credential: string
): Promise<Doc<'machineSessions'>> {
	const session = await ctx.db.get('machineSessions', sessionId);
	if (!session || session.revokedAt !== undefined || session.supersededAt !== undefined) {
		throw new Error('Machine session is not active.');
	}
	const candidateHash = await executionSecretHash(credential);
	if (!constantTimeEqual(candidateHash, session.credentialHash)) {
		throw new Error('Machine session is not active.');
	}
	return session;
}

export const register = mutation({
	args: {
		installationId: v.string(),
		processSessionId: v.string(),
		credentialHash: v.string(),
		friendlyName: v.string(),
		platform: v.string(),
		platformVersion: v.optional(v.string()),
		architecture: v.string(),
		hostname: v.optional(v.string()),
		appVersion: v.string()
	},
	returns: v.object({ sessionId: v.id('machineSessions'), userId: v.string() }),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const now = Date.now();
		for (const value of [
			args.installationId,
			args.processSessionId,
			args.friendlyName,
			args.platform,
			args.architecture,
			args.appVersion
		]) {
			if (!value.trim()) throw new Error('Machine registration fields cannot be empty.');
		}
		if (!/^[0-9a-f]{64}$/.test(args.credentialHash)) {
			throw new Error('Machine credential digest is invalid.');
		}
		const installation = await ctx.db
			.query('installations')
			.withIndex('by_userId_and_installationId', (query) =>
				query.eq('userId', userId).eq('installationId', args.installationId)
			)
			.unique();
		const processSession = await ctx.db
			.query('machineSessions')
			.withIndex('by_userId_and_processSessionId', (query) =>
				query.eq('userId', userId).eq('processSessionId', args.processSessionId)
			)
			.unique();
		if (processSession && processSession.installationId !== args.installationId) {
			throw new Error('Process session belongs to another installation.');
		}
		if (
			processSession &&
			(processSession.supersededAt !== undefined || processSession.revokedAt !== undefined)
		) {
			throw new Error('Process session is no longer active.');
		}

		if (installation?.currentSessionId && installation.currentSessionId !== processSession?._id) {
			const previous = await ctx.db.get('machineSessions', installation.currentSessionId);
			if (previous) {
				await failSessionRuns(ctx, previous);
				await ctx.db.patch('machineSessions', previous._id, { supersededAt: now });
			}
		}

		const sessionId =
			processSession?._id ??
			(await ctx.db.insert('machineSessions', {
				userId,
				installationId: args.installationId,
				processSessionId: args.processSessionId,
				credentialHash: args.credentialHash,
				startedAt: now,
				lastSeenAt: now
			}));
		if (processSession) {
			await ctx.db.patch('machineSessions', sessionId, {
				credentialHash: args.credentialHash,
				lastSeenAt: now,
				supersededAt: undefined,
				revokedAt: undefined
			});
		}

		if (installation) {
			await ctx.db.patch('installations', installation._id, {
				friendlyName: args.friendlyName,
				platform: args.platform,
				platformVersion: args.platformVersion,
				architecture: args.architecture,
				hostname: args.hostname,
				appVersion: args.appVersion,
				currentSessionId: sessionId,
				updatedAt: now
			});
		} else {
			await ctx.db.insert('installations', {
				userId,
				installationId: args.installationId,
				friendlyName: args.friendlyName,
				platform: args.platform,
				platformVersion: args.platformVersion,
				architecture: args.architecture,
				hostname: args.hostname,
				appVersion: args.appVersion,
				currentSessionId: sessionId,
				createdAt: now,
				updatedAt: now
			});
		}
		return { sessionId, userId };
	}
});

export const heartbeat = mutation({
	args: { sessionId: v.id('machineSessions'), credential: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await requireProcessSession(ctx, args.sessionId, args.credential);
		await ctx.db.patch('machineSessions', session._id, { lastSeenAt: Date.now() });
		return null;
	}
});

export const end = mutation({
	args: { sessionId: v.id('machineSessions'), credential: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await requireProcessSession(ctx, args.sessionId, args.credential);
		await failSessionRuns(ctx, session);
		await ctx.db.patch('machineSessions', session._id, { revokedAt: Date.now() });
		return null;
	}
});
