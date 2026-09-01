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

export async function requireIdentity(
	ctx: GenericActionCtx<DataModel> | GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>
): Promise<UserIdentity> {
	const identity: UserIdentity | null = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Authentication required.');
	}
	return identity;
}

/** Earliest row wins so first-login duplicates converge deterministically. */
export function pickPrimaryUser(rows: Array<Doc<'users'>>): Doc<'users'> | null {
	if (rows.length === 0) return null;
	return [...rows].sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id))[0];
}

/** Query-safe lookup of the caller's users row; null until their first
 * ensureCurrentUser ran. */
export async function getCurrentUser(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>
): Promise<Doc<'users'> | null> {
	const subject = await getUserId(ctx);
	const rows = await ctx.db
		.query('users')
		.withIndex('by_subject', (query) => query.eq('subject', subject))
		.collect();
	return pickPrimaryUser(rows);
}

/** Mutation/action-only: resolves the caller's users row, creating it on
 * first sight. */
export async function ensureCurrentUser(ctx: GenericMutationCtx<DataModel>): Promise<Doc<'users'>> {
	const identity = await requireIdentity(ctx);
	const email = identity.email!;
	const rows = await ctx.db
		.query('users')
		.withIndex('by_subject', (query) => query.eq('subject', identity.subject))
		.collect();
	if (rows.length > 0) {
		let primary = pickPrimaryUser(rows);
		if (!primary) throw new Error('Failed to resolve the user record.');
		// A first-login race can insert two rows for one subject; converge on
		// the earliest instead of poisoning later unique reads.
		for (const extra of rows) {
			if (extra._id !== primary._id) await ctx.db.delete('users', extra._id);
		}
		if (email !== primary.email) {
			await ctx.db.patch('users', primary._id, { email });
			primary = { ...primary, email };
		}
		return primary;
	}
	const newUser = {
		subject: identity.subject,
		tokenIdentifier: identity.tokenIdentifier,
		createdAt: Date.now(),
		email
	};
	const id = await ctx.db.insert('users', newUser);
	const created = await ctx.db.get('users', id);
	if (!created) throw new Error('Failed to create the user record.');
	return created;
}

/** Canonical ownership gate for documents whose `userId` holds the auth
 * subject. Throws for missing docs and foreign docs alike so existence
 * never leaks. */
export async function requireOwner<T extends { userId: string }>(
	ctx: GenericActionCtx<DataModel> | GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	doc: T | null
): Promise<T> {
	if (!doc) {
		throw new Error('Not found.');
	}
	const identity = await requireIdentity(ctx);
	if (doc.userId !== identity.subject) {
		throw new Error('Not found.');
	}
	return doc;
}

async function hashExecutionSecret(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(left: string, right: string): boolean {
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
	const run = await ctx.db.get('runs', runId);
	if (!run) throw new Error('Run not found.');
	const candidateHash = await hashExecutionSecret(executionSecret);
	if (!constantTimeEqual(candidateHash, run.executionSecretHash)) throw new Error('Run not found.');
	return run;
}
