import { mutation, query, type MutationCtx } from '@convex/_generated/server';
import type { Doc } from '@convex/_generated/dataModel';
import { v } from 'convex/values';
import { getRunWithExecution } from '@convex/lib/runExecution';
import { getUserId } from '@convex/lib/auth';
import {
	getOwnedMachine,
	isMachineActive,
	MACHINE_ONLINE_THRESHOLD_MS,
	MAX_ACTIVE_MACHINE_RUNS,
	requireMachineProcess
} from '@convex/lib/machineRuns';
import { abandonRunRecord } from '@convex/lib/runFinalize';

const vMachinePresence = v.object({
	machineId: v.string(),
	friendlyName: v.string(),
	platform: v.string(),
	platformVersion: v.string(),
	architecture: v.string(),
	hostname: v.string(),
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
		const run = await getRunWithExecution(ctx.db, runId);

		if (run) {
			await abandonRunRecord(ctx, run);
		}
	}

	await ctx.db.patch('machines', machine._id, { runIds: [] });
}

export const registerProcess = mutation({
	args: {
		machineId: v.string(),
		friendlyName: v.string(),
		platform: v.string(),
		platformVersion: v.string(),
		architecture: v.string(),
		hostname: v.string(),
		appVersion: v.string(),
		processId: v.string()
	},
	returns: v.union(
		v.object({ status: v.literal('registered'), machineId: v.string(), userId: v.string() }),
		v.object({ status: v.literal('busy'), retryAfterMs: v.number() })
	),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
		const now = Date.now();

		for (const value of [
			args.machineId,
			args.processId,
			args.friendlyName,
			args.platform,
			args.architecture,
			args.appVersion
		]) {
			if (!value.trim()) throw new Error('Machine registration fields cannot be empty.');
		}

		const existing = await getOwnedMachine(ctx, userId, args.machineId);

		const metadata = {
			friendlyName: args.friendlyName,
			platform: args.platform,
			platformVersion: args.platformVersion,
			architecture: args.architecture,
			hostname: args.hostname,
			appVersion: args.appVersion,
			processId: args.processId,
			lastSeenAt: now,
			updatedAt: now
		};

		if (existing) {
			const sameProcess = existing.processId === args.processId;

			if (!sameProcess && existing.lastSeenAt !== undefined && isMachineActive(existing, now)) {
				return {
					status: 'busy' as const,
					retryAfterMs: existing.lastSeenAt + MACHINE_ONLINE_THRESHOLD_MS + 1 - now
				};
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
				...metadata
			});
		}

		return { status: 'registered' as const, machineId: args.machineId, userId };
	}
});

const vProcess = { machineId: v.string(), processId: v.string() };

export const heartbeatProcess = mutation({
	args: vProcess,
	returns: v.null(),
	handler: async (ctx, args) => {
		const machine = await requireMachineProcess(
			ctx,
			await getUserId(ctx),
			args.machineId,
			args.processId
		);

		await ctx.db.patch('machines', machine._id, { lastSeenAt: Date.now(), updatedAt: Date.now() });

		return null;
	}
});

export const endProcess = mutation({
	args: vProcess,
	returns: v.null(),
	handler: async (ctx, args) => {
		const machine = await requireMachineProcess(
			ctx,
			await getUserId(ctx),
			args.machineId,
			args.processId
		);

		await failMachineRuns(ctx, machine);
		await ctx.db.patch('machines', machine._id, { lastSeenAt: undefined, updatedAt: Date.now() });

		return null;
	}
});
