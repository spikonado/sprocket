import type {
	GenericActionCtx,
	GenericMutationCtx,
	GenericQueryCtx,
	UserIdentity
} from 'convex/server';
import type { DataModel } from '@convex/_generated/dataModel';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { internalQuery } from '@convex/_generated/server';
import { v } from 'convex/values';

/** The canonical owner key plus its pre-tokenIdentifier predecessor. Owned
 * tables now store `identity.tokenIdentifier` in `userId`; rows written
 * before the switch still carry `identity.subject` until the backfill
 * rewrites them, so callers that read owner-scoped rows resolve both. */
export type OwnerKeys = {
	userId: string;
	subject: string;
};

export function distinctOwnerKeys(keys: OwnerKeys): string[] {
	return keys.userId === keys.subject ? [keys.userId] : [keys.userId, keys.subject];
}

export function matchesOwner(storedUserId: string, keys: OwnerKeys): boolean {
	return storedUserId === keys.userId || storedUserId === keys.subject;
}

export function ownerKeysFromIdentity(identity: UserIdentity): OwnerKeys {
	return { userId: identity.tokenIdentifier, subject: identity.subject };
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

export async function getOwnerKeys(
	ctx: GenericActionCtx<DataModel> | GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>
): Promise<OwnerKeys> {
	return ownerKeysFromIdentity(await requireIdentity(ctx));
}

/** Canonical owner key (identity.tokenIdentifier). Every new row stores this
 * in `userId`. */
export async function getUserId(
	ctx: GenericActionCtx<DataModel> | GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>
): Promise<string> {
	return (await getOwnerKeys(ctx)).userId;
}

/** Maps a stored owner key (canonical tokenIdentifier or legacy subject) to
 * the subject the pre-migration rows were saved under, when a users row
 * exists for it. Returns null for users without a row; legacy rows for such
 * users stay reachable only by their subject. */
export async function resolveStoredOwnerSubject(
	ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
	userId: string
): Promise<string | null> {
	const byToken = await ctx.db
		.query('users')
		.withIndex('by_tokenIdentifier', (query) => query.eq('tokenIdentifier', userId))
		.unique();
	if (byToken) {
		return byToken.subject;
	}
	const bySubject = await ctx.db
		.query('users')
		.withIndex('by_subject', (query) => query.eq('subject', userId))
		.unique();
	if (bySubject) {
		return bySubject.subject;
	}
	return null;
}

/** Public mirror of {@link resolveStoredOwnerSubject} for actions: turns a
 * stored owner key (tokenIdentifier or legacy subject) into the pre-migration
 * subject when the users row is known, else null. Used to keep Prava customer
 * ids stable across the switch. */
export const storedOwnerSubject = internalQuery({
	args: { userId: v.string() },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		return await resolveStoredOwnerSubject(ctx, args.userId);
	}
});

/** Earliest row wins so first-login duplicates converge deterministically. */
export function pickPrimaryUser(rows: Array<Doc<'users'>>): Doc<'users'> | null {
	if (rows.length === 0) return null;
	return [...rows].sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id))[0];
}

/** Mutation/action-only: resolves the caller's users row, creating it on
 * first sight. Rows written before the tokenIdentifier switch lack the
 * tokenIdentifier match but do carry the caller's subject, so adopt them in
 * place instead of duplicating the user. */
export async function ensureCurrentUser(ctx: GenericMutationCtx<DataModel>): Promise<Doc<'users'>> {
	const identity = await requireIdentity(ctx);
	const email = identity.email;
	const existing = await ctx.db
		.query('users')
		.withIndex('by_tokenIdentifier', (query) =>
			query.eq('tokenIdentifier', identity.tokenIdentifier)
		)
		.unique();
	if (existing) {
		if (email && email !== existing.email) {
			await ctx.db.patch('users', existing._id, { email });
			return { ...existing, email };
		}
		return existing;
	}
	const legacy = await ctx.db
		.query('users')
		.withIndex('by_subject', (query) => query.eq('subject', identity.subject))
		.unique();
	if (legacy) {
		const patch = email
			? { tokenIdentifier: identity.tokenIdentifier, email }
			: { tokenIdentifier: identity.tokenIdentifier };
		await ctx.db.patch('users', legacy._id, patch);
		return { ...legacy, ...patch };
	}
	const newUser = {
		subject: identity.subject,
		tokenIdentifier: identity.tokenIdentifier,
		createdAt: Date.now(),
		email: email ?? ''
	};
	const id = await ctx.db.insert('users', newUser);
	const created = await ctx.db.get('users', id);
	if (!created) throw new Error('Failed to create the user record.');
	return created;
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
	const run = await ctx.db.get('runs', runId);
	if (!run) throw new Error('Run not found.');
	const candidateHash = await hashExecutionSecret(executionSecret);
	if (!constantTimeEqual(candidateHash, run.executionSecretHash)) throw new Error('Run not found.');
	return run;
}
