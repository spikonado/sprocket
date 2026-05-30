import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server';
import type { DataModel } from '@convex/_generated/dataModel';
import { authKit } from '@convex/auth';
import { normalizeGuestUserId } from '@convex/lib/guestIdentity';

export async function getUserId(
	ctx: GenericMutationCtx<DataModel> | GenericQueryCtx<DataModel>,
	guestId?: string
): Promise<string> {
	const authUser = await authKit.getAuthUser(ctx);
	if (authUser?.id) {
		return authUser.id;
	}

	return normalizeGuestUserId(guestId);
}
