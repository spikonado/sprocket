import type { Doc, Id } from '@convex/_generated/dataModel';
import type { MutationCtx, QueryCtx } from '@convex/_generated/server';
import { constantTimeEqual, executionSecretHash } from '@convex/lib/auth';

export const MAX_ACTIVE_MACHINE_RUNS = 64;
export const MACHINE_ONLINE_THRESHOLD_MS = 90_000;
export const REMOTE_PROTOCOL_VERSION = 1 as const;

export function isMachineActive(machine: Doc<'machines'>, now = Date.now()): boolean {
	return (
		machine.lastSeenAt !== undefined && now - machine.lastSeenAt <= MACHINE_ONLINE_THRESHOLD_MS
	);
}

export function isRemoteProtocolCapable(machine: Doc<'machines'>): boolean {
	return machine.remoteProtocolVersion === REMOTE_PROTOCOL_VERSION;
}

export async function requireMachineProcess(
	ctx: QueryCtx | MutationCtx,
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

export async function requireActiveMachineProcess(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	machineId: string,
	credential: string
): Promise<Doc<'machines'>> {
	const machine = await requireMachineProcess(ctx, userId, machineId, credential);
	if (!isMachineActive(machine)) {
		throw new Error('Machine is not active.');
	}
	return machine;
}

export async function getOwnedMachine(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	machineId: string
): Promise<Doc<'machines'> | null> {
	return await ctx.db
		.query('machines')
		.withIndex('by_userId_and_machineId', (query) =>
			query.eq('userId', userId).eq('machineId', machineId)
		)
		.unique();
}

export function runMachineId(run: Doc<'runs'>): string | undefined {
	return run.machineId;
}

export async function attachRunToMachine(
	ctx: MutationCtx,
	machine: Doc<'machines'>,
	runId: Id<'runs'>
): Promise<void> {
	const latest = (await ctx.db.get('machines', machine._id)) ?? machine;
	if (latest.runIds.length >= MAX_ACTIVE_MACHINE_RUNS) {
		throw new Error('Machine has too many active runs.');
	}
	if (latest.runIds.includes(runId)) return;
	await ctx.db.patch('machines', latest._id, { runIds: [...latest.runIds, runId] });
}

export async function detachRunFromMachine(ctx: MutationCtx, run: Doc<'runs'>): Promise<void> {
	const machineId = runMachineId(run);
	if (!machineId) return;
	const machine = await getOwnedMachine(ctx, run.userId, machineId);
	if (!machine?.runIds.includes(run._id)) return;
	await ctx.db.patch('machines', machine._id, {
		runIds: machine.runIds.filter((id) => id !== run._id)
	});
}
