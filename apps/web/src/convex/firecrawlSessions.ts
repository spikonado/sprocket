import { ConvexError, v } from 'convex/values';
import {
	paginationOptsValidator,
	paginationResultValidator,
	type PaginationResult
} from 'convex/server';
import type { Doc } from '@convex/_generated/dataModel';
import { internal } from '@convex/_generated/api';
import { internalMutation, internalQuery } from '@convex/_generated/server';
import { isRunClaimLeaseActive } from '@convex/lib/runLease';
import schema from '@convex/schema';

const OPERATION_LEASE_MS = 180_000;

export const acquire = internalMutation({
	args: {
		threadId: v.id('threadRecords'),
		userId: v.string(),
		runId: v.id('runs'),
		claimId: v.string(),
		operationId: v.string(),
		disable_saving: v.optional(v.boolean())
	},
	returns: schema.doc('firecrawlSessions'),
	handler: async (ctx, args) => {
		const now = Date.now();
		const run = await ctx.db.get('runs', args.runId);
		if (
			!run ||
			run.cancellationRequestedAt !== undefined ||
			run.userId !== args.userId ||
			run.threadId !== args.threadId ||
			run.claimId !== args.claimId ||
			!isRunClaimLeaseActive(run, now)
		) {
			throw new ConvexError('The run claim is no longer active.');
		}
		const existing = await ctx.db
			.query('firecrawlSessions')
			.withIndex('by_threadId', (q) => q.eq('threadId', args.threadId))
			.unique();
		if (existing) {
			const profile = await ctx.db
				.query('browserProfiles')
				.withIndex('by_userId', (q) => q.eq('userId', args.userId))
				.unique();
			if (profile?.name !== existing.profileName) {
				throw new ConvexError(
					'browser_reset: This browser is being closed after a profile reset. Retry shortly.'
				);
			}
			if (existing.humanControl)
				throw new ConvexError(
					'browser_in_use: The user has control of this browser. Ask them to give control back before browsing.'
				);
			if (existing.closing || existing.expiresAt <= now) {
				throw new ConvexError('browser_closing: The browser is closing. Retry shortly.');
			}
			if (existing.operationId && existing.operationExpiresAt > now) {
				throw new ConvexError(
					"browser_busy: Another action is using this conversation's browser. Retry after it finishes."
				);
			}
			if (!existing.sessionId) {
				throw new ConvexError(
					'browser_starting: Session creation has not completed. Retry shortly.'
				);
			}
			if (args.disable_saving && existing.saveChanges) {
				throw new ConvexError(
					'saving_mode_fixed: This browser was opened with saving enabled. disable_saving applies only when opening a new session. No action was executed.'
				);
			}
			await ctx.db.patch('firecrawlSessions', existing._id, {
				operationId: args.operationId,
				operationExpiresAt: now + OPERATION_LEASE_MS,
				lastUsedRunId: args.runId
			});
			return {
				...existing,
				operationId: args.operationId,
				operationExpiresAt: now + OPERATION_LEASE_MS,
				lastUsedRunId: args.runId
			};
		}
		let profile = await ctx.db
			.query('browserProfiles')
			.withIndex('by_userId', (q) => q.eq('userId', args.userId))
			.unique();
		if (!profile) {
			const id = await ctx.db.insert('browserProfiles', {
				userId: args.userId,
				name: `sprocket-${crypto.randomUUID()}`,
				savingEnabled: true
			});
			profile = await ctx.db.get('browserProfiles', id);
		}
		if (!profile) throw new Error('Browser profile was not created.');
		const sessions = await ctx.db
			.query('firecrawlSessions')
			.withIndex('by_userId', (q) => q.eq('userId', args.userId))
			.take(100);
		if (sessions.length >= 100)
			throw new ConvexError(
				'Too many browser sessions. Close an existing session before opening another.'
			);
		const id = await ctx.db.insert('firecrawlSessions', {
			threadId: args.threadId,
			userId: args.userId,
			profileName: profile.name,
			saveChanges: profile.savingEnabled && !args.disable_saving,
			lastUsedRunId: args.runId,
			startedAt: now,
			expiresAt: now + 3_600_000,
			operationId: args.operationId,
			operationExpiresAt: now + OPERATION_LEASE_MS,
			closing: false
		});
		await ctx.scheduler.runAfter(OPERATION_LEASE_MS, internal.firecrawlSessions.recoverCreation, {
			id
		});
		const session = await ctx.db.get('firecrawlSessions', id);
		if (!session) throw new Error('Browser session was not reserved.');
		return session;
	}
});

export const attach = internalMutation({
	args: {
		id: v.id('firecrawlSessions'),
		operationId: v.string(),
		sessionId: v.string(),
		expiresAt: v.number(),
		liveViewUrl: v.optional(v.string()),
		interactiveLiveViewUrl: v.optional(v.string())
	},
	returns: v.boolean(),
	handler: async (ctx, { id, operationId, ...remote }) => {
		const session = await ctx.db.get('firecrawlSessions', id);
		if (!session || session.operationId !== operationId) return false;
		await ctx.db.patch('firecrawlSessions', id, { ...remote, attachedAt: Date.now() });
		if (session.closing || session.operationExpiresAt <= Date.now()) {
			await ctx.db.patch('firecrawlSessions', id, { closing: true });
			await ctx.scheduler.runAfter(0, internal.firecrawlBrowser.close, { id });
			return false;
		}
		await ctx.scheduler.runAt(remote.expiresAt, internal.firecrawlSessions.expire, { id });
		return true;
	}
});

export const release = internalMutation({
	args: {
		id: v.id('firecrawlSessions'),
		operationId: v.string(),
		destroyed: v.optional(v.boolean())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get('firecrawlSessions', args.id);
		if (session?.operationId !== args.operationId) return null;
		if (args.destroyed || !session.sessionId) {
			await ctx.db.delete('firecrawlSessions', args.id);
		} else {
			await ctx.db.patch('firecrawlSessions', args.id, {
				operationId: undefined,
				operationExpiresAt: 0
			});
		}
		return null;
	}
});

export const beforeExecute = internalMutation({
	args: {
		id: v.id('firecrawlSessions'),
		operationId: v.string(),
		runId: v.id('runs'),
		claimId: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get('firecrawlSessions', args.id);
		const run = await ctx.db.get('runs', args.runId);
		if (
			!session ||
			session.closing ||
			session.humanControl ||
			session.expiresAt <= Date.now() ||
			session.operationId !== args.operationId ||
			session.operationExpiresAt <= Date.now() ||
			!run ||
			run.cancellationRequestedAt !== undefined ||
			run.claimId !== args.claimId ||
			!isRunClaimLeaseActive(run, Date.now())
		) {
			throw new ConvexError('The browser or run changed before execution. No action ran.');
		}
		await ctx.db.patch('firecrawlSessions', args.id, {
			operationExpiresAt: Date.now() + OPERATION_LEASE_MS
		});
		return null;
	}
});

export const recoverCreation = internalMutation({
	args: { id: v.id('firecrawlSessions') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const session = await ctx.db.get('firecrawlSessions', id);
		if (session && !session.sessionId && session.operationExpiresAt <= Date.now()) {
			await ctx.db.delete('firecrawlSessions', id);
		}
		return null;
	}
});

export const quarantine = internalMutation({
	args: { id: v.id('firecrawlSessions'), operationId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get('firecrawlSessions', args.id);
		if (session?.operationId === args.operationId) {
			await ctx.db.patch('firecrawlSessions', args.id, { closing: true });
			await ctx.scheduler.runAfter(0, internal.firecrawlBrowser.close, { id: args.id });
		}
		return null;
	}
});

export const expire = internalMutation({
	args: { id: v.id('firecrawlSessions') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const session = await ctx.db.get('firecrawlSessions', id);
		if (session && session.expiresAt <= Date.now()) {
			await ctx.db.patch('firecrawlSessions', id, { closing: true });
			await ctx.scheduler.runAfter(0, internal.firecrawlBrowser.close, { id });
		}
		return null;
	}
});

export const claimClose = internalMutation({
	args: { id: v.id('firecrawlSessions'), operationId: v.string() },
	returns: v.union(schema.doc('firecrawlSessions'), v.null()),
	handler: async (ctx, args) => {
		const session = await ctx.db.get('firecrawlSessions', args.id);
		if (!session) return null;
		if (session.operationId && session.operationExpiresAt > Date.now()) {
			await ctx.scheduler.runAt(session.operationExpiresAt, internal.firecrawlBrowser.close, {
				id: args.id
			});
			return null;
		}
		await ctx.db.patch('firecrawlSessions', args.id, {
			closing: true,
			operationId: args.operationId,
			operationExpiresAt: Date.now() + OPERATION_LEASE_MS
		});
		await ctx.scheduler.runAfter(OPERATION_LEASE_MS, internal.firecrawlBrowser.close, {
			id: args.id
		});
		return session;
	}
});

export const list = internalQuery({
	args: { paginationOpts: paginationOptsValidator },
	returns: paginationResultValidator(schema.doc('firecrawlSessions')),
	handler: async (ctx, args): Promise<PaginationResult<Doc<'firecrawlSessions'>>> =>
		await ctx.db.query('firecrawlSessions').paginate(args.paginationOpts)
});

export const reconcile = internalMutation({
	args: { ids: v.array(v.id('firecrawlSessions')), before: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		for (const id of args.ids) {
			const session = await ctx.db.get('firecrawlSessions', id);
			if (
				session &&
				session.attachedAt !== undefined &&
				session.attachedAt < args.before &&
				session.sessionId &&
				(!session.operationId || session.operationExpiresAt <= args.before)
			) {
				await ctx.db.delete('firecrawlSessions', id);
			}
		}
		return null;
	}
});
