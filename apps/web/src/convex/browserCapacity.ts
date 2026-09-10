import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery } from '@convex/_generated/server';

export const active = internalQuery({
	args: {},
	handler: async (ctx) =>
		await ctx.db.query('browserCapacity').withIndex('by_expiresAt').order('desc').take(2)
});

export const reserve = internalMutation({
	args: { reservationId: v.string(), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('browserCapacity')
			.withIndex('by_reservationId', (q) => q.eq('reservationId', args.reservationId))
			.unique();
		if (existing) return null;
		const occupied = await ctx.db
			.query('browserCapacity')
			.withIndex('by_expiresAt', (q) => q.gt('expiresAt', Date.now()))
			.take(2);
		if (occupied.length === 2)
			throw new ConvexError(
				'Both browser session slots are in use. Stop an existing browser session or wait for one to close before opening another.'
			);
		await ctx.db.insert('browserCapacity', args);
		return null;
	}
});

export const attach = internalMutation({
	args: { reservationId: v.string(), sessionId: v.string() },
	returns: v.null(),
	handler: async (ctx, { reservationId, sessionId }) => {
		const slot = await ctx.db
			.query('browserCapacity')
			.withIndex('by_reservationId', (q) => q.eq('reservationId', reservationId))
			.unique();
		if (!slot) throw new Error('Browser capacity reservation is missing.');
		await ctx.db.patch('browserCapacity', slot._id, { sessionId });
		return null;
	}
});

export const releaseReservation = internalMutation({
	args: { reservationId: v.string() },
	returns: v.null(),
	handler: async (ctx, { reservationId }) => {
		const slot = await ctx.db
			.query('browserCapacity')
			.withIndex('by_reservationId', (q) => q.eq('reservationId', reservationId))
			.unique();
		if (slot) await ctx.db.delete('browserCapacity', slot._id);
		return null;
	}
});

export const releaseSession = internalMutation({
	args: { sessionId: v.string() },
	returns: v.null(),
	handler: async (ctx, { sessionId }) => {
		const slot = await ctx.db
			.query('browserCapacity')
			.withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
			.unique();
		if (slot) await ctx.db.delete('browserCapacity', slot._id);
		return null;
	}
});

export const expire = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const expired = await ctx.db
			.query('browserCapacity')
			.withIndex('by_expiresAt', (q) => q.lte('expiresAt', Date.now()))
			.take(100);
		for (const slot of expired) await ctx.db.delete('browserCapacity', slot._id);
		return null;
	}
});
