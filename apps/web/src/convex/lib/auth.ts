import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel } from '@convex/_generated/dataModel';

export type ResolvedActor = {
	ownerId: string;
	guestId?: string;
	identity: {
		subject?: string;
		email?: string;
		name?: string;
		tokenIdentifier: string;
	} | null;
};

function normalizeGuestId(guestId?: string) {
	const trimmed = guestId?.trim();
	return trimmed ? trimmed : undefined;
}

export async function resolveActor(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	guestId?: string
): Promise<ResolvedActor> {
	const identity = await ctx.auth.getUserIdentity();
	if (identity?.tokenIdentifier) {
		return {
			ownerId: identity.tokenIdentifier,
			identity: {
				subject: identity.subject ?? undefined,
				email: identity.email ?? undefined,
				name: identity.name ?? undefined,
				tokenIdentifier: identity.tokenIdentifier
			}
		};
	}

	const normalizedGuestId = normalizeGuestId(guestId);
	if (!normalizedGuestId) {
		throw new Error('Authentication required.');
	}

	return {
		ownerId: normalizedGuestId,
		guestId: normalizedGuestId,
		identity: null
	};
}

export async function getActorId(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	guestId?: string
): Promise<string> {
	return (await resolveActor(ctx, guestId)).ownerId;
}
