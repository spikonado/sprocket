import { HOUR, RateLimiter, isRateLimitError } from '@convex-dev/rate-limiter';
import { components } from '@convex/_generated/api';
import type { ActionCtx, MutationCtx } from '@convex/_generated/server';

const signedInHourlyMessageLimit = 30;
const guestHourlyMessageLimit = 8;
const signedInHourlyThreadCreateLimit = 60;
const guestHourlyThreadCreateLimit = 20;
const signedInHourlyWorkspaceWriteLimit = 180;
const guestHourlyWorkspaceWriteLimit = 60;

export const rateLimiter = new RateLimiter(components.rateLimiter, {
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
});

type RateLimitCtx = ActionCtx | MutationCtx;

function formatRetryAfter(milliseconds: number) {
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
	ctx: RateLimitCtx,
	name:
		| 'signedInSendMessage'
		| 'guestSendMessage'
		| 'signedInCreateThread'
		| 'guestCreateThread'
		| 'signedInWorkspaceMutation'
		| 'guestWorkspaceMutation',
	key: string,
	label: string
) {
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

export async function enforceSignedInSendLimit(ctx: RateLimitCtx, userId: string) {
	await enforceLimit(ctx, 'signedInSendMessage', `user:${userId}`, 'Signed-in message limit');
}

export async function enforceGuestSendLimit(ctx: RateLimitCtx, guestId: string) {
	await enforceLimit(ctx, 'guestSendMessage', `guest:${guestId}`, 'Guest message limit');
}

export async function enforceSignedInThreadCreateLimit(ctx: RateLimitCtx, userId: string) {
	await enforceLimit(ctx, 'signedInCreateThread', `user:${userId}`, 'Signed-in thread limit');
}

export async function enforceGuestThreadCreateLimit(ctx: RateLimitCtx, guestId: string) {
	await enforceLimit(ctx, 'guestCreateThread', `guest:${guestId}`, 'Guest thread limit');
}

export async function enforceSignedInWorkspaceWriteLimit(ctx: RateLimitCtx, userId: string) {
	await enforceLimit(
		ctx,
		'signedInWorkspaceMutation',
		`user:${userId}`,
		'Signed-in workspace mutation limit'
	);
}

export async function enforceGuestWorkspaceWriteLimit(ctx: RateLimitCtx, guestId: string) {
	await enforceLimit(
		ctx,
		'guestWorkspaceMutation',
		`guest:${guestId}`,
		'Guest workspace mutation limit'
	);
}
