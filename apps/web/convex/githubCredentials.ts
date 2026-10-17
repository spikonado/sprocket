import { action, internalQuery, type ActionCtx } from '@convex/_generated/server';
import { internal } from '@convex/_generated/api';
import { v } from 'convex/values';
import { z } from 'zod';
import { constantTimeEqual, executionSecretHash } from '@convex/lib/auth';
import { getOwnedMachine } from '@convex/lib/machineRuns';
import {
	credentialName,
	deleteVaultObject,
	readVaultObject,
	storeVaultObject,
	type VaultObject
} from '@convex/lib/workosVault';

const GITHUB_CREDENTIAL_NAME_PREFIX = 'sprocket-github-';

const MAX_GITHUB_HOSTS = 20;

const MAX_TOKEN_LENGTH = 512;

const HOST_PATTERN = /^[a-z0-9][a-z0-9.-]{0,252}$/;

const savedTokensSchema = z.record(z.string(), z.string());

type SavedTokens = z.infer<typeof savedTokensSchema>;

const vSavedToken = v.object({ host: v.string(), token: v.string() });

async function requireUserId(ctx: ActionCtx): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();

	if (!identity) throw new Error('Authentication required.');

	return identity.subject;
}

function normalizedHost(host: string): string {
	const normalized = host.trim().toLowerCase();

	if (!HOST_PATTERN.test(normalized)) throw new Error(`${host} is not a GitHub host name.`);

	return normalized;
}

async function readTokens(userId: string): Promise<{
	name: string;
	object: VaultObject | null;
	tokens: SavedTokens;
}> {
	const name = await credentialName(GITHUB_CREDENTIAL_NAME_PREFIX, userId);
	const object = await readVaultObject(name);

	if (!object) return { name, object, tokens: {} };

	try {
		return { name, object, tokens: savedTokensSchema.parse(JSON.parse(object.value)) };
	} catch {
		throw new Error('WorkOS Vault returned invalid GitHub tokens.');
	}
}

async function writeTokens(
	name: string,
	object: VaultObject | null,
	tokens: SavedTokens
): Promise<void> {
	if (Object.keys(tokens).length === 0) {
		await deleteVaultObject(name, object);
	} else {
		await storeVaultObject(name, JSON.stringify(tokens), object);
	}
}

/** Saves a token for one GitHub host. Browsers can't read it back; only the user's machines can. */
export const saveToken = action({
	args: { host: v.string(), token: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const host = normalizedHost(args.host);
		const token = args.token.trim();

		if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
			throw new Error('Enter a valid GitHub token.');
		}

		const { name, object, tokens } = await readTokens(userId);

		if (!(host in tokens) && Object.keys(tokens).length >= MAX_GITHUB_HOSTS) {
			throw new Error(`Save tokens for at most ${MAX_GITHUB_HOSTS} GitHub hosts.`);
		}

		await writeTokens(name, object, { ...tokens, [host]: token });

		return null;
	}
});

export const removeToken = action({
	args: { host: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const host = normalizedHost(args.host);
		const { name, object, tokens } = await readTokens(userId);

		if (!(host in tokens)) return null;
		await writeTokens(
			name,
			object,
			Object.fromEntries(Object.entries(tokens).filter(([saved]) => saved !== host))
		);

		return null;
	}
});

export const authorizeMachine = internalQuery({
	args: { userId: v.string(), machineId: v.string(), credential: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const machine = await getOwnedMachine(ctx, args.userId, args.machineId);
		const candidateHash = await executionSecretHash(args.credential);

		if (
			!machine ||
			machine.lastSeenAt === undefined ||
			!constantTimeEqual(candidateHash, machine.credentialHash)
		) {
			throw new Error('Machine is not active.');
		}

		return null;
	}
});

/** Hands the saved tokens to a running machine, proven by the credential it registered with. */
export const issueTokens = action({
	args: { machineId: v.string(), credential: v.string() },
	returns: v.array(vSavedToken),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		await ctx.runQuery(internal.githubCredentials.authorizeMachine, { userId, ...args });
		const { tokens } = await readTokens(userId);

		return Object.entries(tokens).map(([host, token]) => ({ host, token }));
	}
});
