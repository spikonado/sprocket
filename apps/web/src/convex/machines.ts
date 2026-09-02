import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { v } from 'convex/values';
import { constantTimeEqual, executionSecretHash, getUserId } from '@convex/lib/auth';
import { getOwnedMachine, isMachineActive, MAX_ACTIVE_MACHINE_RUNS } from '@convex/lib/machineRuns';
import { finalizeRunRecord } from '@convex/lib/runFinalize';

const MACHINE_ENDED = 'The machine stopped before this run finished.';

const vMachinePresence = v.object({
	machineId: v.string(),
	friendlyName: v.string(),
	platform: v.string(),
	platformVersion: v.optional(v.string()),
	architecture: v.string(),
	hostname: v.optional(v.string()),
	appVersion: v.string(),
	lastSeenAt: v.optional(v.number()),
	online: v.boolean()
});

export const listMine = query({
	args: {},
	returns: v.array(vMachinePresence),
	handler: async (ctx) => {
		const userId = await getUserId(ctx);
		const now = Date.now();
		const machines = await ctx.db
			.query('machines')
			.withIndex('by_userId_and_machineId', (query) => query.eq('userId', userId))
			.collect();
		return machines.map((machine) => ({
			machineId: machine.machineId,
			friendlyName: machine.friendlyName,
			platform: machine.platform,
			platformVersion: machine.platformVersion,
			architecture: machine.architecture,
			hostname: machine.hostname,
			appVersion: machine.appVersion,
			lastSeenAt: machine.lastSeenAt,
			online: isMachineActive(machine, now)
		}));
	}
});

async function failMachineRuns(ctx: MutationCtx, machine: Doc<'machines'>): Promise<void> {
	if (machine.runIds.length > MAX_ACTIVE_MACHINE_RUNS) {
		throw new Error('Machine has too many active runs to stop safely.');
	}
	for (const runId of machine.runIds) {
		const run = await ctx.db.get('runs', runId);
		if (run) {
			await finalizeRunRecord(ctx, run, {
				text: MACHINE_ENDED,
				status: 'failed',
				lastError: MACHINE_ENDED
			});
		}
	}
	await ctx.db.patch('machines', machine._id, { runIds: [] });
}

async function requireMachine(
	ctx: MutationCtx,
	userId: string,
	machineId: string,
	credential: string
): Promise<Doc<'machines'>> {
	const machine = await getOwnedMachine(ctx, userId, machineId);
	const candidateHash = await executionSecretHash(credential);
	if (
		!machine ||
		machine.lastSeenAt === undefined ||
		!constantTimeEqual(candidateHash, machine.credentialHash)
	) {
		throw new Error('Machine is not active.');
	}
	return machine;
}

export const register = mutation({
	args: {
		machineId: v.string(),
		credentialHash: v.string(),
		friendlyName: v.string(),
		platform: v.string(),
		platformVersion: v.optional(v.string()),
		architecture: v.string(),
		hostname: v.optional(v.string()),
		appVersion: v.string()
	},
	returns: v.object({ machineId: v.string(), userId: v.string() }),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const now = Date.now();
		for (const value of [
			args.machineId,
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
		const existing = await getOwnedMachine(ctx, userId, args.machineId);
		const metadata = {
			friendlyName: args.friendlyName,
			platform: args.platform,
			platformVersion: args.platformVersion,
			architecture: args.architecture,
			hostname: args.hostname,
			appVersion: args.appVersion,
			credentialHash: args.credentialHash,
			lastSeenAt: now,
			updatedAt: now
		};
		if (existing) {
			const sameProcess = constantTimeEqual(existing.credentialHash, args.credentialHash);
			if (!sameProcess && isMachineActive(existing, now)) {
				throw new Error('Machine is already active on another process.');
			}
			if (!sameProcess) {
				await failMachineRuns(ctx, existing);
			}
			await ctx.db.patch('machines', existing._id, metadata);
		} else {
			await ctx.db.insert('machines', {
				userId,
				machineId: args.machineId,
				runIds: [],
				createdAt: now,
				...metadata
			});
		}
		return { machineId: args.machineId, userId };
	}
});

export const heartbeat = mutation({
	args: { userId: v.string(), machineId: v.string(), credential: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const machine = await requireMachine(ctx, args.userId, args.machineId, args.credential);
		await ctx.db.patch('machines', machine._id, { lastSeenAt: Date.now(), updatedAt: Date.now() });
		return null;
	}
});

export const end = mutation({
	args: { userId: v.string(), machineId: v.string(), credential: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const machine = await requireMachine(ctx, args.userId, args.machineId, args.credential);
		await failMachineRuns(ctx, machine);
		await ctx.db.patch('machines', machine._id, {
			lastSeenAt: undefined,
			updatedAt: Date.now()
		});
		return null;
	}
});
