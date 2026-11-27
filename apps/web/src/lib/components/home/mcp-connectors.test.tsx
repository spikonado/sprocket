import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import type { FunctionArgs } from 'convex/server';
import { api } from '@convex/_generated/api';
import { ConvexTestClient, ConvexTestProvider } from '$lib/convex-test-client';
import type { McpConnector } from '$lib/types/sprocket';
import McpConnectors, { RequestedConnectorSetup, type McpApi } from './mcp-connectors';
import type { RemoteMcpServer } from './mcp-connectors-client';
import AgentQuestion from './agent-question';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function remoteServer(overrides: Partial<RemoteMcpServer> = {}): RemoteMcpServer {
	return {
		connectorId: 'linear',
		catalogId: undefined,
		name: 'Linear',
		url: 'https://mcp.linear.test/mcp',
		auth: 'oauth',
		headerNames: [],
		status: 'needs_auth',
		policies: [],
		...overrides
	};
}

function localApi(overrides: Partial<McpApi> = {}): McpApi {
	const unused = async () => Promise.reject(new Error('Unexpected local MCP call.'));

	return {
		fetchMcpConnectors: async () => [],
		addMcpConnector: unused,
		removeMcpConnector: unused,
		fetchMcpTools: unused,
		setMcpToolPolicy: unused,
		...overrides
	};
}

function client(servers: RemoteMcpServer[] = []) {
	const convex = new ConvexTestClient();
	convex.registerQuery(api.mcpServers.listMine, servers);

	return convex;
}

it.each([
	{ url: 'https://mcp.linear.test/mcp', remote: true },
	{ url: 'http://mcp.linear.test/mcp', remote: true },
	{ url: 'https://127.example.test/mcp', remote: true },
	{ url: 'http://localhost:3000/mcp', remote: false },
	{ url: 'http://127.0.0.2:3000/mcp', remote: false },
	{ url: 'http://127.1:3000/mcp', remote: false },
	{ url: 'http://[::1]:3000/mcp', remote: false }
])('adds $url through the correct credential store', async ({ url, remote }) => {
	const convex = client();
	const addRemote = vi.fn(async () => 'linear');
	convex.handleAction(api.mcpServers.add, addRemote);

	const addLocal = vi.fn<McpApi['addMcpConnector']>(async () => ({
		id: 'linear',
		name: 'Linear',
		transport: { type: 'http', url, headers: ['Authorization'] }
	}));

	render(
		<ConvexTestProvider client={convex}>
			<McpConnectors userId="user-a" localApi={localApi({ addMcpConnector: addLocal })} />
		</ConvexTestProvider>
	);
	const form = within(screen.getByRole('form', { name: 'Custom connector' }));
	const urlButton = form.getByRole('button', { name: 'URL' });
	fireEvent.click(urlButton);
	fireEvent.change(form.getByLabelText('Name'), {
		target: { value: 'Linear' }
	});
	fireEvent.change(form.getByLabelText('URL'), { target: { value: url } });
	fireEvent.click(form.getByRole('button', { name: 'Add header' }));
	fireEvent.change(form.getByLabelText('header 1 name'), {
		target: { value: 'Authorization' }
	});
	fireEvent.change(form.getByLabelText('header 1 value'), {
		target: { value: 'Bearer secret' }
	});
	fireEvent.click(form.getByRole('button', { name: 'Add connector' }));

	if (remote) {
		await waitFor(() =>
			expect(addRemote).toHaveBeenCalledWith({
				name: 'Linear',
				url,
				headers: { Authorization: 'Bearer secret' }
			})
		);
		expect(addLocal).not.toHaveBeenCalled();
	} else {
		await waitFor(() =>
			expect(addLocal).toHaveBeenCalledWith('user-a', {
				name: 'Linear',
				transport: {
					type: 'http',
					url,
					headers: { Authorization: 'Bearer secret' }
				}
			})
		);
		expect(addRemote).not.toHaveBeenCalled();
	}
});

it('shows local and remote connectors and removes a remote one through Convex', async () => {
	const server = remoteServer();
	const convex = client([server]);

	const local: McpConnector = {
		id: 'linear',
		name: 'Local Linear',
		transport: { type: 'stdio', command: 'linear-mcp', args: [], env: [] }
	};

	const removeRemote = vi.fn(async () => null);
	convex.handleAction(api.mcpServers.remove, removeRemote);
	const removeLocal = vi.fn<McpApi['removeMcpConnector']>(async () => {});

	render(
		<ConvexTestProvider client={convex}>
			<McpConnectors
				userId="user-a"
				localApi={localApi({
					fetchMcpConnectors: async () => [local],
					removeMcpConnector: removeLocal
				})}
			/>
		</ConvexTestProvider>
	);
	expect(await screen.findByText('Local Linear')).toBeTruthy();
	expect(screen.getAllByText('Linear')).toHaveLength(1);
	expect(screen.getByText('Needs sign-in')).toBeTruthy();

	await act(async () =>
		convex.registerQuery(api.mcpServers.listMine, [{ ...server, status: 'connected' }])
	);
	expect(screen.getAllByText('Connected')).toHaveLength(2);
	const card = screen.getByText('Linear').closest<HTMLDivElement>('.rounded-xl');

	if (!card) throw new Error('Missing remote connector card.');
	fireEvent.click(within(card).getByRole('button', { name: 'Remove' }));
	await waitFor(() => expect(removeRemote).toHaveBeenCalledWith({ connectorId: 'linear' }));
	expect(removeLocal).not.toHaveBeenCalled();
	await act(async () => convex.registerQuery(api.mcpServers.listMine, []));
	expect(screen.queryByText('Linear')).toBeNull();
	expect(screen.getByText('Local Linear')).toBeTruthy();
});

it('loads canonical remote tool IDs and saves account policies reactively', async () => {
	const server = remoteServer({
		status: 'connected',
		policies: [{ tool: 'create_issue', policy: 'disabled' }]
	});

	const convex = client([server]);
	convex.registerMutation(api.mcpServers.setPolicy, null);
	const mutation = vi.spyOn(convex, 'mutation');

	const fetchMcpTools = vi.fn<McpApi['fetchMcpTools']>(async () => [
		{
			name: 'create_issue',
			readOnly: false,
			destructive: false,
			policy: 'ask'
		}
	]);

	render(
		<ConvexTestProvider client={convex}>
			<McpConnectors userId="user-a" localApi={localApi({ fetchMcpTools })} />
		</ConvexTestProvider>
	);
	fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
	const control = within(await screen.findByRole('group', { name: 'create_issue permission' }));
	expect(fetchMcpTools).toHaveBeenCalledWith('user-a', 'remote:linear');
	expect(control.getByRole('button', { name: 'Disabled' }).getAttribute('aria-pressed')).toBe(
		'true'
	);
	fireEvent.click(control.getByRole('button', { name: 'Enabled' }));
	await waitFor(() =>
		expect(mutation).toHaveBeenCalledWith(
			api.mcpServers.setPolicy,
			{
				connectorId: 'linear',
				tool: 'create_issue',
				policy: 'enabled'
			},
			expect.anything()
		)
	);
	expect(control.getByRole('button', { name: 'Enabled' }).getAttribute('aria-pressed')).toBe(
		'true'
	);
	await act(async () =>
		convex.registerQuery(api.mcpServers.listMine, [
			{ ...server, policies: [{ tool: 'create_issue', policy: 'ask' }] }
		])
	);
	expect(control.getByRole('button', { name: 'Ask' }).getAttribute('aria-pressed')).toBe('true');
});

it('asks for an OAuth client and answers a remote request only after authorization', async () => {
	const convex = client();
	const server = remoteServer();
	const addRemote = vi.fn(async () => 'linear');
	convex.handleAction(api.mcpServers.add, addRemote);

	const startOAuth = vi
		.fn<
			(
				args: FunctionArgs<typeof api.mcpServers.startOAuth>
			) => Promise<{ authorizationUrl: string }>
		>()
		.mockRejectedValueOnce(
			new ConvexError({
				code: 'client_required',
				message: 'Register an OAuth client with Linear.'
			})
		)
		.mockResolvedValue({
			authorizationUrl: 'https://auth.linear.test/authorize'
		});

	convex.handleAction(api.mcpServers.startOAuth, startOAuth);
	const openExternal = vi.fn(async () => {});
	vi.stubGlobal('sprocketDesktopBridge', { openExternal });
	const onConnected = vi.fn();

	render(
		<ConvexTestProvider client={convex}>
			<RequestedConnectorSetup
				userId="user-a"
				localApi={null}
				connector={{
					type: 'http',
					name: 'Linear',
					url: server.url,
					headers: []
				}}
				onConnected={onConnected}
			/>
		</ConvexTestProvider>
	);
	fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
	await waitFor(() =>
		expect(addRemote).toHaveBeenCalledWith({
			name: 'Linear',
			url: server.url,
			headers: {}
		})
	);
	expect(onConnected).not.toHaveBeenCalled();
	await act(async () => convex.registerQuery(api.mcpServers.listMine, [server]));
	fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
	expect(await screen.findByText('Register an OAuth client with Linear.')).toBeTruthy();
	fireEvent.change(screen.getByLabelText('Client ID'), {
		target: { value: 'my-client' }
	});
	fireEvent.change(screen.getByLabelText('Client secret (optional)'), {
		target: { value: 'my-secret' }
	});
	fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
	await waitFor(() =>
		expect(openExternal).toHaveBeenCalledWith('https://auth.linear.test/authorize')
	);
	expect(startOAuth).toHaveBeenLastCalledWith({
		connectorId: 'linear',
		client: { clientId: 'my-client', clientSecret: 'my-secret' }
	});
	expect(onConnected).not.toHaveBeenCalled();
	await act(async () =>
		convex.registerQuery(api.mcpServers.listMine, [{ ...server, status: 'connected' }])
	);
	expect(onConnected).toHaveBeenCalledTimes(1);
});

it('opens a browser popup before starting OAuth and follows the returned authorization URL', async () => {
	const convex = client([remoteServer()]);
	const replace = vi.fn();
	const close = vi.fn();
	const loginWindow = { location: { replace }, close, opener: window };
	vi.stubGlobal('sprocketDesktopBridge', undefined);
	const open = vi.fn(() => loginWindow);
	vi.stubGlobal('open', open);
	convex.handleAction(api.mcpServers.startOAuth, async () => {
		expect(open).toHaveBeenCalledWith('about:blank', '_blank');
		expect(loginWindow.opener).toBeNull();

		return { authorizationUrl: 'https://auth.linear.test/authorize' };
	});
	render(
		<ConvexTestProvider client={convex}>
			<McpConnectors userId="user-a" localApi={null} />
		</ConvexTestProvider>
	);
	fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
	await waitFor(() => expect(replace).toHaveBeenCalledWith('https://auth.linear.test/authorize'));
	expect(screen.getByText(/Finish connecting in your browser/)).toBeTruthy();
});

it('reuses a connected server by normalized URL when its request card is reopened', async () => {
	const server = remoteServer({ status: 'connected' });
	const convex = client([server]);
	const onConnected = vi.fn();
	const addRemote = vi.fn(async () => 'linear-2');
	convex.handleAction(api.mcpServers.add, addRemote);

	render(
		<ConvexTestProvider client={convex}>
			<RequestedConnectorSetup
				userId="user-a"
				localApi={null}
				connector={{
					type: 'http',
					name: 'Linear',
					url: ' HTTPS://MCP.LINEAR.TEST:443/./mcp#request ',
					headers: []
				}}
				onConnected={onConnected}
			/>
		</ConvexTestProvider>
	);
	await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
	expect(addRemote).not.toHaveBeenCalled();
});

it('reconnects a canonical remote ID requested by the agent', async () => {
	const server = remoteServer();
	const convex = client([server]);
	const onAnswer = vi.fn();

	const startOAuth = vi.fn(async () => ({
		authorizationUrl: 'https://auth.linear.test/authorize'
	}));

	convex.handleAction(api.mcpServers.startOAuth, startOAuth);
	vi.stubGlobal('sprocketDesktopBridge', {
		openExternal: vi.fn(async () => {})
	});

	render(
		<ConvexTestProvider client={convex}>
			<AgentQuestion
				question="Reconnect Linear"
				options={[{ id: 'connected', label: 'Connected' }]}
				detail={{
					type: 'connector',
					connector: { type: 'known', id: 'remote:linear' }
				}}
				runEnded={false}
				selectedOptionId={null}
				onToggleOption={vi.fn()}
				onAnswer={onAnswer}
				connectorSetup={{ userId: 'user-a', localApi: null }}
			/>
		</ConvexTestProvider>
	);
	fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
	await waitFor(() => expect(startOAuth).toHaveBeenCalledWith({ connectorId: 'linear' }));
	expect(onAnswer).not.toHaveBeenCalled();
	await act(async () =>
		convex.registerQuery(api.mcpServers.listMine, [{ ...server, status: 'connected' }])
	);
	expect(onAnswer).toHaveBeenCalledWith('connected');
});
