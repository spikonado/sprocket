import { action } from '@convex/_generated/server';
import { v } from 'convex/values';
import { z } from 'zod';
import { getUserId } from '@convex/lib/auth';
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

/** Saves a token for one GitHub host. */
export const saveToken = action({
	args: { host: v.string(), token: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await getUserId(ctx);
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
		const userId = await getUserId(ctx);
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

export const issueTokens = action({
	args: {},
	returns: v.record(v.string(), v.string()),
	handler: async (ctx) => {
		const { tokens } = await readTokens(await getUserId(ctx));

		return tokens;
	}
});
