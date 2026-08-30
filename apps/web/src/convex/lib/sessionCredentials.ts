import { v } from 'convex/values';
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel, Doc } from '@convex/_generated/dataModel';

/** A session credential lets a local executor act for a user without holding
 * the WorkOS access token. The row stores only hashes; the rotation is
 * client-driven (the executor generates the next secret and presents it), so
 * losing a rotation response cannot desynchronize the chain. */
/** Proof presented on identity-sensitive calls. `next` is ignored if present
 * so a leaked Convex argument cannot steal the rotation chain. */
export const vSessionCredentialProof = v.object({
	sessionId: v.string(),
	userId: v.string(),
	current: v.string(),
	next: v.optional(v.string())
});

export const vSessionCredentialTicket = v.object({
	sessionId: v.string(),
	userId: v.string(),
	current: v.string(),
	next: v.string()
});

export type SessionCredentialProof = {
	sessionId: string;
	userId: string;
	current: string;
};

export type SessionCredentialTicket = SessionCredentialProof & {
	next: string;
};

/** The Rust rotator refreshes at this cadence. */
export const SESSION_CREDENTIAL_REFRESH_MS = 5 * 60_000;

/** A credential whose chain was not advanced for this long is dead. Two
 * refresh marks. Missing one mark (rotating at 10 minutes instead of 5) is
 * still accepted. */
export const SESSION_CREDENTIAL_MAX_GAP_MS = 2 * SESSION_CREDENTIAL_REFRESH_MS;

async function hashSecret(secret: string): Promise<string> {
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

export function sessionCredentialExpiresAt(lastRefreshTime: number): number {
	return lastRefreshTime + SESSION_CREDENTIAL_MAX_GAP_MS;
}

export async function sessionCredentialRow(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	sessionId: string
): Promise<Doc<'sessionCredentials'> | null> {
	return await ctx.db
		.query('sessionCredentials')
		.withIndex('by_sessionId', (query) => query.eq('sessionId', sessionId))
		.unique();
}

/** Mints the initial {current, next} pair for a freshly authorized user. The
 * browser relays these to the local server once; from then on the server
 * rotates on its own. */
export async function issueSessionCredentialPair(
	ctx: GenericMutationCtx<DataModel>,
	userId: string,
	subject: string
): Promise<{
	sessionId: string;
	current: string;
	next: string;
	expiresAt: number;
	refreshAfterMs: number;
}> {
	const sessionId = crypto.randomUUID();
	const current = crypto.randomUUID();
	const next = crypto.randomUUID();
	const now = Date.now();
	await ctx.db.insert('sessionCredentials', {
		sessionId,
		userId,
		subject,
		currentHash: await hashSecret(current),
		previousHash: '',
		lastRefreshTime: now,
		createdAt: now
	});
	return {
		sessionId,
		current,
		next,
		expiresAt: sessionCredentialExpiresAt(now),
		refreshAfterMs: SESSION_CREDENTIAL_REFRESH_MS
	};
}

/** Advances the chain to the presented `next` secret. Idempotent: if the
 * presented pair matches the previous chain element (a retry after the
 * original rotation commit was lost), the row is not advanced again and the
 * same success is returned. */
export async function rotateSessionCredential(
	ctx: GenericMutationCtx<DataModel>,
	row: Doc<'sessionCredentials'>,
	ticket: SessionCredentialTicket
): Promise<{ expiresAt: number; refreshAfterMs: number }> {
	const now = Date.now();
	if (row.userId !== ticket.userId) {
		throw new Error('Invalid session credential.');
	}
	if (now - row.lastRefreshTime >= SESSION_CREDENTIAL_MAX_GAP_MS) {
		throw new Error('Session credential expired.');
	}
	const presentedHash = await hashSecret(ticket.current);
	const nextHash = await hashSecret(ticket.next);

	const isRetry =
		constantTimeEqual(presentedHash, row.previousHash) &&
		constantTimeEqual(nextHash, row.currentHash);
	if (isRetry) {
		return {
			expiresAt: sessionCredentialExpiresAt(row.lastRefreshTime),
			refreshAfterMs: SESSION_CREDENTIAL_REFRESH_MS
		};
	}

	if (!constantTimeEqual(presentedHash, row.currentHash)) {
		throw new Error('Invalid session credential.');
	}
	await ctx.db.patch('sessionCredentials', row._id, {
		currentHash: nextHash,
		previousHash: presentedHash,
		lastRefreshTime: now
	});
	return {
		expiresAt: sessionCredentialExpiresAt(now),
		refreshAfterMs: SESSION_CREDENTIAL_REFRESH_MS
	};
}

/** Resolves the owning identity for a presented credential, or null. Used by
 * endpoints that are otherwise callable without the WorkOS identity. */
export async function authorizeBySessionCredential(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	ticket: SessionCredentialProof
): Promise<{ userId: string; subject: string } | null> {
	const row = await sessionCredentialRow(ctx, ticket.sessionId);
	if (
		!row ||
		row.userId !== ticket.userId ||
		Date.now() - row.lastRefreshTime >= SESSION_CREDENTIAL_MAX_GAP_MS
	) {
		return null;
	}
	const presentedHash = await hashSecret(ticket.current);
	const valid =
		constantTimeEqual(presentedHash, row.currentHash) ||
		constantTimeEqual(presentedHash, row.previousHash);
	if (!valid) {
		return null;
	}
	return { userId: row.userId, subject: row.subject };
}
