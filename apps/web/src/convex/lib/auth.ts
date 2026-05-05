import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel } from '@convex/_generated/dataModel';
import { authKit } from '@convex/auth';

export async function getUserId(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	guestId?: string
): Promise<string> {
	const authUser = await authKit.getAuthUser(ctx);
	if (authUser?.id) {
		return authUser.id;
	}

	const normalizedGuestId: string | undefined = guestId?.trim();
	if (!normalizedGuestId) {
		throw new Error('Authentication required.');
	}
	return `guest:${normalizedGuestId}`;
}
