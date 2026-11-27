import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import agentErrorMessages from '@convex/lib/agentErrorCodes.json';
import { credentialName } from '@convex/lib/workosVault';
import { api } from './_generated/api';
import {
	initConvexTest,
	stubVault,
	type ConvexTestInstance,
	type FetchHandler
} from './test.setup';

const SERVER_URL = 'https://mcp.example.com/mcp';

const ISSUER = 'https://auth.example.com';

const SITE_URL = 'https://sprocket-test.convex.site';

const USER = 'user_alice';

const machine = {
	machineId: 'machine-a',
	friendlyName: 'Workshop',
	platform: 'linux',
	platformVersion: '6.12.1',
	architecture: 'x86_64',
	hostname: 'workbench',
	appVersion: '0.6.0'
};

type TokenHandler = (params: URLSearchParams) => Response;

function oauthServer(
	metadata: Record<string, string | boolean | string[]>,
	onToken: TokenHandler = () => new Response(null, { status: 500 })
) {
	let registrations = 0;

	const handler: FetchHandler = (url, init) => {
		switch (`${init?.method ?? 'GET'} ${url.href}`) {
			case `POST ${SERVER_URL}`:
				return new Response(null, {
					status: 401,
					headers: {
						'www-authenticate': `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="issues:read"`
					}
				});
			case 'GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp':
				return Response.json({ resource: SERVER_URL, authorization_servers: [ISSUER] });
			case `GET ${ISSUER}/.well-known/oauth-authorization-server`:
				return Response.json({
					issuer: ISSUER,
					authorization_endpoint: `${ISSUER}/authorize`,
					token_endpoint: `${ISSUER}/token`,
					code_challenge_methods_supported: ['S256'],
					...metadata
				});
			case `POST ${ISSUER}/register`:
				registrations += 1;

				return Response.json({ client_id: `dcr-client-${registrations}` }, { status: 201 });
			case `POST ${ISSUER}/token`:
				return onToken(new URLSearchParams(String(init?.body)));
			default:
				return new Response(null, { status: 404 });
		}
	};

	return { handler, registrations: () => registrations };
}

async function seedServer(t: ConvexTestInstance, connectorId: string) {
	await t.run((ctx) =>
		ctx.db.insert('mcpServers', {
			userId: USER,
			connectorId,
			name: 'Linear',
			url: SERVER_URL,
			auth: 'oauth',
			headerNames: [],
			status: 'needs_auth'
		})
	);
}

async function startOAuth(
	t: ConvexTestInstance,
	connectorId: string,
	client?: { clientId: string; clientSecret?: string }
) {
	const { authorizationUrl } = await t
		.withIdentity({ subject: USER })
		.action(api.mcpServers.startOAuth, { connectorId, client });

	return new URL(authorizationUrl).searchParams;
}

function tokenResponse(accessToken: string, refreshToken: string) {
	return Response.json({
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: 3600,
		refresh_token: refreshToken
	});
}

describe('remote MCP servers', () => {
	beforeEach(() => {
		vi.stubEnv('WORKOS_API_KEY', 'sk_workos_test');
		vi.stubEnv('WORKOS_CLIENT_ID', 'client_test');
		vi.stubEnv('CONVEX_SITE_URL', SITE_URL);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('picks the pasted client, then CIMD, then DCR, then asks for a client', async () => {
		const cimdAndDcr = oauthServer({
			client_id_metadata_document_supported: true,
			registration_endpoint: `${ISSUER}/register`
		});

		stubVault(cimdAndDcr.handler);
		const t = initConvexTest();

		for (const connectorId of ['pasted', 'cimd', 'dcr', 'dcr-2', 'none']) {
			await seedServer(t, connectorId);
		}

		const pasted = await startOAuth(t, 'pasted', { clientId: 'my-client' });
		expect(pasted.get('client_id')).toBe('my-client');
		expect((await startOAuth(t, 'pasted')).get('client_id')).toBe('my-client');

		const cimd = await startOAuth(t, 'cimd');
		expect(cimd.get('client_id')).toBe(`${SITE_URL}/oauth/mcp/client-metadata.json`);
		expect(cimd.get('redirect_uri')).toBe(`${SITE_URL}/oauth/mcp/callback`);
		expect(cimd.get('resource')).toBe(SERVER_URL);
		expect(cimd.get('code_challenge_method')).toBe('S256');
		expect(cimd.get('scope')).toBe('issues:read');

		const dcrOnly = oauthServer({ registration_endpoint: `${ISSUER}/register` });
		stubVault(dcrOnly.handler);
		expect((await startOAuth(t, 'dcr')).get('client_id')).toBe('dcr-client-1');
		expect((await startOAuth(t, 'dcr-2')).get('client_id')).toBe('dcr-client-1');
		expect(dcrOnly.registrations()).toBe(1);

		stubVault(oauthServer({}).handler);
		await expect(startOAuth(t, 'none')).rejects.toMatchObject({
			data: { code: 'client_required' }
		});
	});

	it('accepts each authorization response once and only before it expires', async () => {
		const vault = stubVault(
			oauthServer({ client_id_metadata_document_supported: true }, (params) =>
				params.get('code') === 'code-1' && params.get('code_verifier')
					? tokenResponse('access-1', 'refresh-1')
					: new Response(null, { status: 500 })
			).handler
		);

		const t = initConvexTest();
		await seedServer(t, 'linear');
		const state = (await startOAuth(t, 'linear')).get('state')!;

		const callback = (value: string) =>
			t.fetch(`/oauth/mcp/callback?state=${value}&code=code-1&iss=${ISSUER}`);

		expect((await callback('unknown')).status).toBe(400);
		expect((await callback(state)).status).toBe(200);
		expect((await callback(state)).status).toBe(400);

		const [server] = await t.withIdentity({ subject: USER }).query(api.mcpServers.listMine, {});
		expect(server).toMatchObject({ connectorId: 'linear', status: 'connected' });
		const stored = vault.get(await credentialName('sprocket-mcp-', `${USER}/linear`));
		expect(JSON.parse(stored!.value)).toMatchObject({ accessToken: 'access-1' });

		const expired = (await startOAuth(t, 'linear')).get('state')!;
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('mcpOAuthStates')
				.withIndex('by_state', (q) => q.eq('state', expired))
				.unique();

			await ctx.db.patch('mcpOAuthStates', row!._id, { expiresAt: Date.now() - 1 });
		});
		expect((await callback(expired)).status).toBe(400);
		expect(await t.run((ctx) => ctx.db.query('mcpOAuthStates').collect())).toEqual([]);
	});

	describe('issueCredential', () => {
		async function seedExpiredToken(onToken: TokenHandler) {
			const vault = stubVault(oauthServer({}, onToken).handler);
			const t = initConvexTest();
			const asUser = t.withIdentity({ subject: USER });
			await seedServer(t, 'linear');
			await t.run(async (ctx) => {
				const server = await ctx.db.query('mcpServers').unique();
				await ctx.db.patch('mcpServers', server!._id, { status: 'connected' });
			});
			await asUser.mutation(api.machines.registerProcess, { ...machine, processId: 'process-a' });
			const name = await credentialName('sprocket-mcp-', `${USER}/linear`);

			vault.set(name, {
				id: 'secret_linear',
				name,
				metadata: { version_id: 'version_expired' },
				value: JSON.stringify({
					type: 'oauth',
					accessToken: 'access-old',
					refreshToken: 'refresh-old',
					expiresAt: Date.now() - 1,
					issuer: ISSUER,
					tokenEndpoint: `${ISSUER}/token`,
					resource: SERVER_URL,
					clientId: 'client',
					tokenEndpointAuthMethod: 'none'
				})
			});

			const issue = (processId = 'process-a') =>
				asUser.action(api.mcpServers.issueCredential, {
					connectorId: 'linear',
					machineId: machine.machineId,
					processId
				});

			return { asUser, vault, name, issue };
		}

		it('uses the token of a concurrent refresh that wrote first', async () => {
			const seeded = await seedExpiredToken(() => {
				const entry = seeded.vault.get(seeded.name)!;
				const value = { ...JSON.parse(entry.value), accessToken: 'access-winner' };
				value.expiresAt = Date.now() + 3_600_000;
				seeded.vault.set(seeded.name, {
					...entry,
					value: JSON.stringify(value),
					metadata: { version_id: 'version_winner' }
				});

				return tokenResponse('access-loser', 'refresh-loser');
			});

			await expect(seeded.issue()).resolves.toMatchObject({
				headers: { Authorization: 'Bearer access-winner' }
			});
			expect(JSON.parse(seeded.vault.get(seeded.name)!.value)).toMatchObject({
				accessToken: 'access-winner'
			});
		});

		it('asks the user to connect again when the refresh token is rejected', async () => {
			const { asUser, issue } = await seedExpiredToken(() =>
				Response.json({ error: 'invalid_grant' }, { status: 400 })
			);

			await expect(issue('process-b')).rejects.toMatchObject({
				data: agentErrorMessages.MACHINE_NOT_ACTIVE
			});
			await expect(issue()).rejects.toMatchObject({ data: { code: 'needs_auth' } });
			expect(await asUser.query(api.mcpServers.listMine, {})).toMatchObject([
				{ connectorId: 'linear', status: 'needs_auth' }
			]);
		});
	});
});
