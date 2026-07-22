import type {
	GenericActionCtx,
	GenericMutationCtx,
	GenericQueryCtx,
	UserIdentity
} from 'convex/server';
import type { DataModel } from '@convex/_generated/dataModel';
import type { Doc, Id } from '@convex/_generated/dataModel';

export async function getUserId(
	ctx: GenericActionCtx<DataModel> | GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>
): Promise<string> {
	const identity: UserIdentity | null = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Authentication required.');
	}
	return identity.subject;
}

async function hashExecutionSecret(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
	let difference = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}

export async function executionSecretHash(secret: string): Promise<string> {
	if (!secret.trim()) throw new Error('Execution secret cannot be empty.');
	return await hashExecutionSecret(secret);
}

/** Authorize a run using the capability held by its local executor. */
export async function getExecutionRun(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	runId: Id<'runs'>,
	executionSecret: string
): Promise<Doc<'runs'>> {
	const run = await ctx.db.get(runId);
	if (!run) throw new Error('Run not found.');
	const candidateHash = await hashExecutionSecret(executionSecret);
	if (!constantTimeEqual(candidateHash, run.executionSecretHash)) throw new Error('Run not found.');
	return run;
}
