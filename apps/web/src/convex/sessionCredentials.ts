import { internalQuery, mutation } from '@convex/_generated/server';
import { v } from 'convex/values';
import { getOwnerKeys } from '@convex/lib/auth';
import {
	vSessionCredentialProof,
	vSessionCredentialTicket,
	authorizeBySessionCredential,
	issueSessionCredentialPair,
	rotateSessionCredential,
	sessionCredentialRow
} from '@convex/lib/sessionCredentials';

export const issue = mutation({
	args: {},
	returns: v.object({
		sessionId: v.string(),
		userId: v.string(),
		subject: v.string(),
		current: v.string(),
		next: v.string(),
		expiresAt: v.number(),
		refreshAfterMs: v.number()
	}),
	handler: async (ctx) => {
		const keys = await getOwnerKeys(ctx);
		const pair = await issueSessionCredentialPair(ctx, keys.userId, keys.subject);
		return { userId: keys.userId, subject: keys.subject, ...pair };
	}
});

export const rotate = mutation({
	args: v.object({
		ticket: vSessionCredentialTicket
	}),
	returns: v.object({
		expiresAt: v.number(),
		refreshAfterMs: v.number()
	}),
	handler: async (ctx, args) => {
		const row = await sessionCredentialRow(ctx, args.ticket.sessionId);
		if (!row) {
			throw new Error('Invalid session credential.');
		}
		return await rotateSessionCredential(ctx, row, args.ticket);
	}
});

export const resolveOwner = internalQuery({
	args: v.object({
		ticket: vSessionCredentialProof
	}),
	returns: v.object({
		userId: v.string(),
		subject: v.string()
	}),
	handler: async (ctx, args) => {
		const owner = await authorizeBySessionCredential(ctx, args.ticket);
		if (!owner) {
			throw new Error('Invalid session credential.');
		}
		return owner;
	}
});
