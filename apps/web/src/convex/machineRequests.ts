import { MINUTE } from '@convex-dev/rate-limiter';
import { ConvexError, v } from 'convex/values';
import { internal } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import {
	internalMutation,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from '@convex/_generated/server';
import { constantTimeEqual, getUserId } from '@convex/lib/auth';
import {
	getOwnedMachine,
	isMachineActive,
	isRemoteProtocolCapable,
	requireActiveMachineProcess,
	requireMachineProcess
} from '@convex/lib/machineRuns';
import { rateLimiter } from '@convex/lib/rateLimits';
import {
	commandsMatch,
	MACHINE_REQUEST_CLAIM_EXPIRED,
	MACHINE_REQUEST_CLAIM_TTL_MS,
	MACHINE_REQUEST_EXPIRED,
	MACHINE_REQUEST_FAIL_PAGE_SIZE,
	MACHINE_REQUEST_NOT_CAPABLE,
	MACHINE_REQUEST_TERMINAL_RETENTION_MS,
	MACHINE_REQUEST_TTL_MS,
	MAX_MACHINE_REQUESTS_IN_FLIGHT,
	requireErrorBound,
	requireExclusiveCompletion,
	requireRequestId,
	requireResultBound,
	sameCompletion,
	validateMachineCommand,
	vMachineCommand,
	vMachineRequestGetResult,
	vMachineRequestSnapshot,
	type MachineRequestGetResult,
	type MachineRequestSnapshot
} from '@convex/lib/machineRequests';

const ENQUEUE_RATE = {
	kind: 'fixed window',
	period: MINUTE,
	rate: 30
} as const;

function requireEnqueueDeadline(expiresAt: number, now: number): number {
	if (!Number.isFinite(expiresAt)) {
		throw new Error('Hosted command expiresAt must be a finite timestamp.');
	}
	if (expiresAt <= now) {
		throw new Error('This hosted command expired before it was queued.');
	}
	return Math.min(expiresAt, now + MACHINE_REQUEST_TTL_MS);
}

function snapshot(request: Doc<'machineRequests'>): MachineRequestSnapshot {
	return {
		_id: request._id,
		command: request.command,
		userId: request.userId,
		expiresAt: request.expiresAt
	};
}

function view(request: Doc<'machineRequests'>): MachineRequestGetResult {
	const result: MachineRequestGetResult = { status: request.status };
	if (request.result !== undefined) result.result = request.result;
	if (request.error !== undefined) result.error = request.error;
	return result;
}

async function requireHostedCommandMachine(
	ctx: MutationCtx,
	userId: string,
	machineId: string,
	now: number
): Promise<Doc<'machines'>> {
	const machine = await getOwnedMachine(ctx, userId, machineId);
	if (!machine || !isMachineActive(machine, now)) {
		throw new Error('Machine is not active.');
	}
	if (!isRemoteProtocolCapable(machine)) {
		throw new Error(MACHINE_REQUEST_NOT_CAPABLE);
	}
	return machine;
}

async function loadProcessRequest(
	ctx: MutationCtx,
	machine: Doc<'machines'>,
	id: Id<'machineRequests'>
): Promise<Doc<'machineRequests'> | null> {
	const request = await ctx.db.get('machineRequests', id);
	if (
		!request ||
		request.userId !== machine.userId ||
		request.machineId !== machine.machineId ||
		!constantTimeEqual(request.credentialHash, machine.credentialHash)
	) {
		return null;
	}
	return request;
}

async function nextPendingRequest(
	ctx: Pick<QueryCtx, 'db'>,
	machine: Doc<'machines'>,
	now: number
): Promise<Doc<'machineRequests'> | null> {
	const pending = await ctx.db
		.query('machineRequests')
		.withIndex('by_userId_and_machineId_and_status', (query) =>
			query.eq('userId', machine.userId).eq('machineId', machine.machineId).eq('status', 'pending')
		)
		.take(MAX_MACHINE_REQUESTS_IN_FLIGHT);
	for (const request of pending) {
		if (
			request.expiresAt > now &&
			constantTimeEqual(request.credentialHash, machine.credentialHash)
		) {
			return request;
		}
	}
	return null;
}

async function scheduleTerminalDelete(ctx: MutationCtx, id: Id<'machineRequests'>): Promise<void> {
	await ctx.scheduler.runAfter(
		MACHINE_REQUEST_TERMINAL_RETENTION_MS,
		internal.machineRequests.deleteTerminal,
		{ id }
	);
}

async function markFailed(
	ctx: MutationCtx,
	request: Doc<'machineRequests'>,
	error: string,
	now = Date.now()
): Promise<void> {
	if (request.status === 'completed' || request.status === 'failed') return;
	await ctx.db.patch('machineRequests', request._id, {
		status: 'failed',
		error,
		completedAt: now,
		result: undefined
	});
	await scheduleTerminalDelete(ctx, request._id);
}

async function failStaleInFlight(
	ctx: MutationCtx,
	userId: string,
	machineId: string,
	now: number
): Promise<void> {
	const pending = await ctx.db
		.query('machineRequests')
		.withIndex('by_userId_and_machineId_and_status', (query) =>
			query.eq('userId', userId).eq('machineId', machineId).eq('status', 'pending')
		)
		.take(MAX_MACHINE_REQUESTS_IN_FLIGHT);
	for (const request of pending) {
		if (request.expiresAt <= now) {
			await markFailed(ctx, request, MACHINE_REQUEST_EXPIRED, now);
		}
	}
	const claimed = await ctx.db
		.query('machineRequests')
		.withIndex('by_userId_and_machineId_and_status', (query) =>
			query.eq('userId', userId).eq('machineId', machineId).eq('status', 'claimed')
		)
		.take(MAX_MACHINE_REQUESTS_IN_FLIGHT);
	for (const request of claimed) {
		if (request.claimExpiresAt !== undefined && request.claimExpiresAt <= now) {
			await markFailed(ctx, request, MACHINE_REQUEST_CLAIM_EXPIRED, now);
		}
	}
}

async function countInFlight(ctx: MutationCtx, userId: string, machineId: string): Promise<number> {
	let count = 0;
	for (const status of ['pending', 'claimed'] as const) {
		const page = await ctx.db
			.query('machineRequests')
			.withIndex('by_userId_and_machineId_and_status', (query) =>
				query.eq('userId', userId).eq('machineId', machineId).eq('status', status)
			)
			.take(MAX_MACHINE_REQUESTS_IN_FLIGHT + 1);
		count += page.length;
	}
	return count;
}

async function failOpenMachineRequests(
	ctx: MutationCtx,
	args: { userId: string; machineId: string; credentialHash: string; error: string }
): Promise<void> {
	const now = Date.now();
	for (const status of ['pending', 'claimed'] as const) {
		const page = await ctx.db
			.query('machineRequests')
			.withIndex('by_userId_and_machineId_and_credentialHash_and_status', (query) =>
				query
					.eq('userId', args.userId)
					.eq('machineId', args.machineId)
					.eq('credentialHash', args.credentialHash)
					.eq('status', status)
			)
			.take(MACHINE_REQUEST_FAIL_PAGE_SIZE);
		for (const request of page) {
			await markFailed(ctx, request, args.error, now);
		}
		if (page.length === MACHINE_REQUEST_FAIL_PAGE_SIZE) {
			await ctx.scheduler.runAfter(0, internal.machineRequests.failOpenPage, args);
			return;
		}
	}
}

export const enqueue = mutation({
	args: {
		machineId: v.string(),
		requestId: v.string(),
		command: vMachineCommand,
		expiresAt: v.number()
	},
	returns: v.id('machineRequests'),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const requestId = requireRequestId(args.requestId);
		validateMachineCommand(args.command);
		const now = Date.now();
		const existing = await ctx.db
			.query('machineRequests')
			.withIndex('by_userId_and_requestId', (query) =>
				query.eq('userId', userId).eq('requestId', requestId)
			)
			.unique();
		if (existing) {
			if (existing.machineId !== args.machineId || !commandsMatch(existing.command, args.command)) {
				throw new Error(
					'A request with this ID already exists with a different command or machine.'
				);
			}
			return existing._id;
		}
		const expiresAt = requireEnqueueDeadline(args.expiresAt, now);
		const machine = await requireHostedCommandMachine(ctx, userId, args.machineId, now);
		const rate = await rateLimiter.limit(ctx, 'machineRequestEnqueue', {
			key: userId,
			config: ENQUEUE_RATE
		});
		if (!rate.ok) {
			throw new ConvexError('Hosted command rate limit reached. Try again shortly.');
		}
		await failStaleInFlight(ctx, userId, args.machineId, now);
		if ((await countInFlight(ctx, userId, args.machineId)) >= MAX_MACHINE_REQUESTS_IN_FLIGHT) {
			throw new Error('This machine already has too many hosted commands in flight.');
		}
		const id = await ctx.db.insert('machineRequests', {
			userId,
			machineId: machine.machineId,
			requestId,
			credentialHash: machine.credentialHash,
			command: args.command,
			status: 'pending',
			expiresAt
		});
		await ctx.scheduler.runAt(expiresAt, internal.machineRequests.expirePending, { id });
		return id;
	}
});

export const next = query({
	args: {
		machineId: v.string(),
		credential: v.string()
	},
	returns: v.union(v.null(), vMachineRequestSnapshot),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const machine = await requireActiveMachineProcess(ctx, userId, args.machineId, args.credential);
		const request = await nextPendingRequest(ctx, machine, Date.now());
		return request ? snapshot(request) : null;
	}
});

export const claim = mutation({
	args: {
		machineId: v.string(),
		credential: v.string(),
		id: v.id('machineRequests')
	},
	returns: v.union(v.null(), vMachineRequestSnapshot),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const machine = await requireActiveMachineProcess(ctx, userId, args.machineId, args.credential);
		const request = await loadProcessRequest(ctx, machine, args.id);
		if (!request || request.status !== 'pending') return null;
		const now = Date.now();
		if (request.expiresAt <= now) {
			await markFailed(ctx, request, MACHINE_REQUEST_EXPIRED, now);
			return null;
		}
		const claimExpiresAt = now + MACHINE_REQUEST_CLAIM_TTL_MS;
		await ctx.db.patch('machineRequests', request._id, {
			status: 'claimed',
			claimedAt: now,
			claimExpiresAt
		});
		await ctx.scheduler.runAfter(
			MACHINE_REQUEST_CLAIM_TTL_MS,
			internal.machineRequests.expireClaim,
			{ id: request._id }
		);
		return snapshot(request);
	}
});

export const complete = mutation({
	args: {
		machineId: v.string(),
		credential: v.string(),
		id: v.id('machineRequests'),
		result: v.optional(v.string()),
		error: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const completion = requireExclusiveCompletion(args);
		requireResultBound(completion.result);
		requireErrorBound(completion.error);
		const userId = await getUserId(ctx);
		const machine = await requireMachineProcess(ctx, userId, args.machineId, args.credential);
		const request = await loadProcessRequest(ctx, machine, args.id);
		if (!request) throw new Error('Not found.');
		const now = Date.now();
		if (request.status === 'completed' || request.status === 'failed') {
			if (sameCompletion(request, completion)) return null;
			throw new Error('Machine request was already completed.');
		}
		if (request.status !== 'claimed') {
			throw new Error('Machine request is not claimed.');
		}
		if (request.claimExpiresAt !== undefined && request.claimExpiresAt <= now) {
			throw new Error('Machine request claim expired.');
		}
		if (completion.error !== undefined) {
			await markFailed(ctx, request, completion.error, now);
			return null;
		}
		await ctx.db.patch('machineRequests', request._id, {
			status: 'completed',
			completedAt: now,
			result: completion.result,
			error: undefined
		});
		await scheduleTerminalDelete(ctx, request._id);
		return null;
	}
});

export const get = query({
	args: { id: v.id('machineRequests') },
	returns: vMachineRequestGetResult,
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const request = await ctx.db.get('machineRequests', args.id);
		if (!request || request.userId !== userId) {
			throw new Error('Not found.');
		}
		// Run creation can commit even when the machine loses the command acknowledgement.
		if (request.command.kind === 'runAgent' && request.status !== 'completed') {
			const submissionId = request.command.submissionId;
			const run = await ctx.db
				.query('runs')
				.withIndex('by_userId_submissionId', (query) =>
					query.eq('userId', userId).eq('submissionId', submissionId)
				)
				.unique();
			if (run?.machineId === request.machineId) {
				return {
					status: 'completed' as const,
					result: JSON.stringify({ runId: run._id, threadId: run.threadId })
				};
			}
		}
		return view(request);
	}
});

export const expirePending = internalMutation({
	args: { id: v.id('machineRequests') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const request = await ctx.db.get('machineRequests', args.id);
		if (!request || request.status !== 'pending') return null;
		const now = Date.now();
		if (request.expiresAt > now) return null;
		await markFailed(ctx, request, MACHINE_REQUEST_EXPIRED, now);
		return null;
	}
});

export const expireClaim = internalMutation({
	args: { id: v.id('machineRequests') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const request = await ctx.db.get('machineRequests', args.id);
		if (!request || request.status !== 'claimed') return null;
		const now = Date.now();
		if (request.claimExpiresAt !== undefined && request.claimExpiresAt > now) return null;
		await markFailed(ctx, request, MACHINE_REQUEST_CLAIM_EXPIRED, now);
		return null;
	}
});

export const deleteTerminal = internalMutation({
	args: { id: v.id('machineRequests') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const request = await ctx.db.get('machineRequests', args.id);
		if (!request) return null;
		if (request.status !== 'completed' && request.status !== 'failed') return null;
		await ctx.db.delete('machineRequests', request._id);
		return null;
	}
});

export const failOpenPage = internalMutation({
	args: {
		userId: v.string(),
		machineId: v.string(),
		credentialHash: v.string(),
		error: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await failOpenMachineRequests(ctx, args);
		return null;
	}
});
