import {
	HOUR,
	RateLimiter,
	isRateLimitError,
	type RateLimitConfig
} from '@convex-dev/rate-limiter';
import { components } from '@convex/_generated/api';
import type { ActionCtx, MutationCtx } from '@convex/_generated/server';

const signedInHourlyMessageLimit = 30;
const guestHourlyMessageLimit = 8;
const signedInHourlyThreadCreateLimit = 60;
const guestHourlyThreadCreateLimit = 20;
const signedInHourlyWorkspaceWriteLimit = 180;
const guestHourlyWorkspaceWriteLimit = 60;

const rateLimitConfigs = {
	signedInSendMessage: {
		kind: 'fixed window',
		period: HOUR,
		rate: signedInHourlyMessageLimit
	},
	guestSendMessage: {
		kind: 'fixed window',
		period: HOUR,
		rate: guestHourlyMessageLimit
	},
	signedInCreateThread: {
		kind: 'fixed window',
		period: HOUR,
		rate: signedInHourlyThreadCreateLimit
	},
	guestCreateThread: {
		kind: 'fixed window',
		period: HOUR,
		rate: guestHourlyThreadCreateLimit
	},
	signedInWorkspaceMutation: {
		kind: 'fixed window',
		period: HOUR,
		rate: signedInHourlyWorkspaceWriteLimit
	},
	guestWorkspaceMutation: {
		kind: 'fixed window',
		period: HOUR,
		rate: guestHourlyWorkspaceWriteLimit
	}
} satisfies Record<string, RateLimitConfig>;

export const rateLimiter = new RateLimiter(components.rateLimiter, rateLimitConfigs);

function formatRetryAfter(milliseconds: number): string {
	const totalSeconds = Math.max(1, Math.ceil(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];

	if (hours > 0) {
		parts.push(`${hours}h`);
	}
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds}s`);
	}

	return parts.join(' ');
}

async function enforceLimit(
	ctx: ActionCtx | MutationCtx,
	name: keyof typeof rateLimitConfigs,
	key: string,
	label: string
): Promise<void> {
	try {
		await rateLimiter.limit(ctx, name, {
			key,
			throws: true
		});
	} catch (error) {
		if (!isRateLimitError(error)) {
			throw error;
		}

		throw new Error(`${label} reached. Try again in ${formatRetryAfter(error.data.retryAfter)}.`);
	}
}

export async function enforceSignedInSendLimit(
	ctx: ActionCtx | MutationCtx,
	userId: string
): Promise<void> {
	await enforceLimit(ctx, 'signedInSendMessage', userId, 'Signed-in message limit');
}

export async function enforceGuestSendLimit(
	ctx: ActionCtx | MutationCtx,
	userId: string
): Promise<void> {
	await enforceLimit(ctx, 'guestSendMessage', userId, 'Guest message limit');
}

export async function enforceSignedInThreadCreateLimit(
	ctx: ActionCtx | MutationCtx,
	userId: string
): Promise<void> {
	await enforceLimit(ctx, 'signedInCreateThread', userId, 'Signed-in thread limit');
}

export async function enforceGuestThreadCreateLimit(
	ctx: ActionCtx | MutationCtx,
	userId: string
): Promise<void> {
	await enforceLimit(ctx, 'guestCreateThread', userId, 'Guest thread limit');
}

export async function enforceSignedInWorkspaceWriteLimit(
	ctx: ActionCtx | MutationCtx,
	userId: string
): Promise<void> {
	await enforceLimit(
		ctx,
		'signedInWorkspaceMutation',
		userId,
		'Signed-in workspace mutation limit'
	);
}

export async function enforceGuestWorkspaceWriteLimit(
	ctx: ActionCtx | MutationCtx,
	userId: string
): Promise<void> {
	await enforceLimit(ctx, 'guestWorkspaceMutation', userId, 'Guest workspace mutation limit');
}
