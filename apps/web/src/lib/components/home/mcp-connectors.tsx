import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronRight, Plug, Plus, X } from 'lucide-react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { AgentQuestionDetail } from '@convex/lib/agentQuestions';
import { cn } from '$lib/utils';
import { catalogConnector, connectorCatalog, type CatalogConnector } from '$lib/connectors/catalog';
import type { LocalApi, McpConnector, McpTool, ToolPolicy } from '$lib/types/sprocket';
import {
	ConnectorCardFrame,
	ConnectorDescription,
	inputClass,
	primaryButtonClass,
	secondaryButtonClass,
	useConnectorAction,
	useOnConnected
} from './connector-card-parts';
import { caughtMessage, usePolledStatus } from './use-connectors';
import {
	remoteMcpConnector,
	useAddMcpConnector,
	type RemoteMcpServer
} from './mcp-connectors-client';
import { useMcpOAuth } from './mcp-oauth';

export type McpApi = Pick<
	LocalApi,
	| 'fetchMcpConnectors'
	| 'addMcpConnector'
	| 'removeMcpConnector'
	| 'fetchMcpTools'
	| 'setMcpToolPolicy'
>;

type RequestedMcpConnector = Exclude<
	Extract<AgentQuestionDetail, { type: 'connector' }>['connector'],
	{ type: 'known' }
>;

const noPolling = () => null;

const policies: { value: ToolPolicy; label: string }[] = [
	{ value: 'enabled', label: 'Enabled' },
	{ value: 'ask', label: 'Ask' },
	{ value: 'disabled', label: 'Disabled' }
];

function McpLogo({ iconUrl }: { iconUrl?: string }) {
	const [failed, setFailed] = useState(false);

	if (iconUrl && !failed) {
		return (
			<img
				src={iconUrl}
				alt=""
				className="size-8 shrink-0 object-contain"
				loading="lazy"
				referrerPolicy="no-referrer"
				onError={() => setFailed(true)}
			/>
		);
	}

	return <Plug className="text-foreground size-8 shrink-0 p-1.5" aria-hidden="true" />;
}

type Transport = McpConnector['transport'] | RequestedMcpConnector;

function transportLine(transport: Transport) {
	if (transport.type === 'http') return transport.url;

	return [transport.command, ...transport.args]
		.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part))
		.join(' ');
}

function secretNames(transport: Transport) {
	return transport.type === 'stdio' ? transport.env : transport.headers;
}

function normalizedMcpUrl(value: string) {
	const url = URL.parse(value.trim());

	if (!url) return null;
	url.hash = '';

	return url.href;
}

export default function McpConnectors({
	userId,
	localApi
}: {
	userId: string;
	localApi: McpApi | null;
}) {
	const remoteServers = useQuery(api.mcpServers.listMine, {});
	const [browsing, setBrowsing] = useState(false);
	const [query, setQuery] = useState('');
	const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

	const matchingCatalog = connectorCatalog.filter((entry) => {
		const text = `${entry.id} ${entry.name} ${entry.description}`.toLowerCase();

		return keywords.every((keyword) => text.includes(keyword));
	});

	const catalogServers = new Map<string, RemoteMcpServer>();

	for (const server of remoteServers ?? []) {
		if (
			server.catalogId &&
			catalogConnector(server.catalogId) &&
			!catalogServers.has(server.catalogId)
		) {
			catalogServers.set(server.catalogId, server);
		}
	}

	const fetchConnectors = useCallback(
		() => (localApi ? localApi.fetchMcpConnectors(userId) : Promise.resolve([])),
		[localApi, userId]
	);

	const {
		status: connectors,
		setStatus: setConnectors,
		loadError
	} = usePolledStatus(
		fetchConnectors,
		noPolling,
		'Couldn’t check MCP connectors on this computer.'
	);

	return (
		<>
			{connectors?.map((connector) => (
				<McpConnectorCard
					key={connector.id}
					userId={userId}
					localApi={localApi}
					connector={connector}
					onRemoved={() =>
						setConnectors(
							(current) => current && current.filter((entry) => entry.id !== connector.id)
						)
					}
				/>
			))}
			{remoteServers
				?.filter((server) => !server.catalogId || catalogServers.get(server.catalogId) !== server)
				.map((server) => {
					const connector = remoteMcpConnector(server);

					return (
						<McpConnectorCard
							key={connector.id}
							userId={userId}
							localApi={localApi}
							connector={connector}
							remote={server}
							catalog={catalogConnector(server.catalogId)}
						/>
					);
				})}
			{loadError && (
				<p role="alert" className="text-destructive text-sm">
					{loadError}
				</p>
			)}
			<button
				type="button"
				className={secondaryButtonClass}
				aria-expanded={browsing}
				onClick={() => {
					setBrowsing((value) => !value);
					setQuery('');
				}}
			>
				Browse connectors
				<ChevronRight
					className={cn('ml-1 size-3.5 transition-transform', browsing && 'rotate-90')}
					aria-hidden="true"
				/>
			</button>
			{browsing && (
				<input
					type="search"
					className={inputClass}
					aria-label="Search connectors"
					placeholder="Search connectors"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
				/>
			)}
			{matchingCatalog.map((entry) => {
				const remote = catalogServers.get(entry.id);

				if (!browsing && !remote) return null;

				return (
					<CatalogConnectorCard
						key={entry.id}
						userId={userId}
						localApi={localApi}
						entry={entry}
						remote={remote}
						loading={remoteServers === undefined}
					/>
				);
			})}
			{browsing && matchingCatalog.length === 0 && (
				<p className="text-muted-foreground text-sm">No connectors match your search.</p>
			)}
			<CustomConnectorForm
				userId={userId}
				localApi={localApi}
				onAdded={(added) => setConnectors((current) => [...(current ?? []), added])}
			/>
		</>
	);
}

function McpConnectorCard({
	userId,
	localApi,
	connector,
	onRemoved,
	remote,
	onConnected,
	catalog,
	loading = false
}: {
	userId: string;
	localApi: McpApi | null;
	connector: McpConnector;
	onRemoved?: () => void;
	remote?: RemoteMcpServer;
	onConnected?: () => void;
	catalog?: CatalogConnector;
	loading?: boolean;
}) {
	const removeRemote = useAction(api.mcpServers.remove);
	useOnConnected(remote?.status === 'connected', onConnected);
	const [open, setOpen] = useState(false);
	const { pending, error, act } = useConnectorAction<'remove'>(connector.name);
	const needsAuth = remote?.status === 'needs_auth';
	const notConnected = catalog !== undefined && !remote;
	const toolsApi = needsAuth || notConnected ? null : localApi;
	const line = transportLine(connector.transport);
	const secrets = secretNames(connector.transport);

	const oauth = useMcpOAuth(
		loading
			? null
			: needsAuth
				? { connectorId: remote.connectorId }
				: notConnected
					? { catalog }
					: null
	);

	return (
		<ConnectorCardFrame
			logo={<McpLogo iconUrl={catalog?.iconUrl} />}
			name={connector.name}
			summary={
				<>
					{catalog ? (
						<ConnectorDescription>{catalog.description}</ConnectorDescription>
					) : (
						<p className="text-muted-foreground mt-0.5 truncate font-mono text-[12px]" title={line}>
							{line}
						</p>
					)}
					{secrets.length > 0 && (
						<p className="text-muted-foreground mt-0.5 truncate text-[12px]">
							{connector.transport.type === 'stdio' ? 'Environment' : 'Headers'}:{' '}
							<span className="font-mono">{secrets.join(', ')}</span>
						</p>
					)}
					<p className="text-muted-foreground mt-0.5 text-[12px]" role="status">
						{loading
							? 'Checking connector…'
							: notConnected
								? 'Not connected'
								: needsAuth
									? 'Needs sign-in'
									: 'Connected'}
					</p>
				</>
			}
			actions={
				<>
					{!notConnected && (
						<>
							<button
								type="button"
								className={secondaryButtonClass}
								aria-expanded={open}
								disabled={!toolsApi}
								onClick={() => setOpen((value) => !value)}
							>
								Tools
								<ChevronRight
									className={cn('ml-1 size-3.5 transition-transform', open && 'rotate-90')}
									aria-hidden="true"
								/>
							</button>
							<button
								type="button"
								className={secondaryButtonClass}
								disabled={pending !== null}
								onClick={() =>
									void act('remove', async () => {
										if (remote) await removeRemote({ connectorId: remote.connectorId });
										else if (localApi) await localApi.removeMcpConnector(userId, connector.id);
										onRemoved?.();
									})
								}
							>
								Remove
							</button>
						</>
					)}
					{oauth.button}
				</>
			}
			error={error}
		>
			{oauth.details}
			{open && toolsApi && (
				<McpToolList
					userId={userId}
					localApi={toolsApi}
					connectorId={connector.id}
					remote={remote}
				/>
			)}
		</ConnectorCardFrame>
	);
}

function CatalogConnectorCard({
	userId,
	localApi,
	entry,
	remote,
	onConnected,
	loading
}: {
	userId: string;
	localApi: McpApi | null;
	entry: CatalogConnector;
	remote?: RemoteMcpServer;
	onConnected?: () => void;
	loading: boolean;
}) {
	return (
		<McpConnectorCard
			userId={userId}
			localApi={localApi}
			connector={
				remote
					? remoteMcpConnector(remote)
					: {
							id: entry.id,
							name: entry.name,
							transport: { type: 'http', url: entry.url, headers: [] }
						}
			}
			remote={remote}
			catalog={entry}
			onConnected={onConnected}
			loading={loading}
		/>
	);
}

export function RequestedCatalogConnectorSetup({
	userId,
	localApi,
	entry,
	onConnected
}: {
	userId: string;
	localApi: McpApi | null;
	entry: CatalogConnector;
	onConnected: () => void;
}) {
	const servers = useQuery(api.mcpServers.listMine, {});
	const remote = servers?.find((server) => server.catalogId === entry.id);

	return (
		<CatalogConnectorCard
			userId={userId}
			localApi={localApi}
			entry={entry}
			remote={remote}
			onConnected={onConnected}
			loading={servers === undefined}
		/>
	);
}

function McpToolList({
	userId,
	localApi,
	connectorId,
	remote
}: {
	userId: string;
	localApi: McpApi;
	connectorId: string;
	remote?: RemoteMcpServer;
}) {
	const setRemotePolicy = useMutation(api.mcpServers.setPolicy).withOptimisticUpdate(
		(store, { connectorId, tool, policy }) => {
			const servers = store.getQuery(api.mcpServers.listMine, {});

			if (!servers) return;
			store.setQuery(
				api.mcpServers.listMine,
				{},
				servers.map((server) =>
					server.connectorId === connectorId
						? {
								...server,
								policies: [
									...server.policies.filter((entry) => entry.tool !== tool),
									{ tool, policy }
								]
							}
						: server
				)
			);
		}
	);

	const fetchTools = useCallback(
		() => localApi.fetchMcpTools(userId, connectorId),
		[localApi, userId, connectorId]
	);

	const {
		status: tools,
		setStatus: setTools,
		loadError
	} = usePolledStatus(fetchTools, noPolling, 'Couldn’t load this connector’s tools.');

	const [saveError, setSaveError] = useState<string | null>(null);

	function withPolicy(name: string, policy: ToolPolicy) {
		setTools(
			(current) =>
				current && current.map((tool) => (tool.name === name ? { ...tool, policy } : tool))
		);
	}

	async function changePolicy(tool: McpTool, policy: ToolPolicy) {
		if (!remote) withPolicy(tool.name, policy);
		setSaveError(null);

		try {
			if (remote)
				await setRemotePolicy({ connectorId: remote.connectorId, tool: tool.name, policy });
			else await localApi.setMcpToolPolicy(userId, connectorId, tool.name, policy);
		} catch (caught) {
			if (!remote) withPolicy(tool.name, tool.policy);
			setSaveError(caughtMessage.parse(caught) || 'Couldn’t save the tool setting.');
		}
	}

	return (
		<div className="border-border border-t">
			{tools === null ? (
				<p
					role={loadError ? 'alert' : undefined}
					className={cn(
						'px-5 py-3 text-[12px]',
						loadError ? 'text-destructive' : 'text-muted-foreground'
					)}
				>
					{loadError ?? 'Connecting…'}
				</p>
			) : tools.length === 0 ? (
				<p className="text-muted-foreground px-5 py-3 text-[12px]">This server has no tools.</p>
			) : (
				<ul className="divide-border divide-y" aria-label="Tools">
					{tools.map((tool) => (
						<li key={tool.name} className="flex items-center gap-3 px-5 py-3">
							<div className="min-w-0 flex-1">
								<p className="text-foreground flex items-center gap-1.5 text-[13px]">
									<span className="truncate font-mono">{tool.name}</span>
									{tool.readOnly && <ToolBadge>Read-only</ToolBadge>}
									{tool.destructive && <ToolBadge>Destructive</ToolBadge>}
								</p>
								{(tool.title ?? tool.description) && (
									<p className="text-muted-foreground mt-0.5 line-clamp-2 text-[12px] leading-5">
										{tool.title ?? tool.description}
									</p>
								)}
							</div>
							<PolicyControl
								tool={tool.name}
								value={
									remote?.policies.find((entry) => entry.tool === tool.name)?.policy ?? tool.policy
								}
								onChange={(policy) => void changePolicy(tool, policy)}
							/>
						</li>
					))}
				</ul>
			)}
			{saveError && (
				<p role="alert" className="text-destructive border-border border-t px-5 py-3 text-[12px]">
					{saveError}
				</p>
			)}
		</div>
	);
}

function ToolBadge({ children }: { children: string }) {
	return (
		<span className="border-border text-muted-foreground shrink-0 rounded-full border px-1.5 text-[11px] leading-4">
			{children}
		</span>
	);
}

function PolicyControl({
	tool,
	value,
	onChange
}: {
	tool: string;
	value: ToolPolicy;
	onChange: (policy: ToolPolicy) => void;
}) {
	return (
		<div
			role="group"
			aria-label={`${tool} permission`}
			className="border-border inline-flex shrink-0 rounded-md border p-0.5"
		>
			{policies.map((policy) => (
				<button
					key={policy.value}
					type="button"
					aria-pressed={value === policy.value}
					className={cn(
						'h-6 rounded px-2 text-[12px] transition',
						value === policy.value
							? 'bg-hover-fill-strong text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					)}
					onClick={() => {
						if (value !== policy.value) onChange(policy.value);
					}}
				>
					{policy.label}
				</button>
			))}
		</div>
	);
}

type SecretRow = { name: string; value: string };

function secretRecord(rows: SecretRow[]) {
	return Object.fromEntries(
		rows.flatMap((row) => (row.name.trim() ? [[row.name.trim(), row.value]] : []))
	);
}

function CustomConnectorForm({
	userId,
	localApi,
	onAdded
}: {
	userId: string;
	localApi: McpApi | null;
	onAdded: (connector: McpConnector) => void;
}) {
	const addConnector = useAddMcpConnector(userId, localApi);
	const [type, setType] = useState<'stdio' | 'http'>(localApi ? 'stdio' : 'http');
	const [name, setName] = useState('');
	const [command, setCommand] = useState('');
	const [args, setArgs] = useState('');
	const [url, setUrl] = useState('');
	const [secrets, setSecrets] = useState<SecretRow[]>([]);
	const { pending, error, act } = useConnectorAction<'add'>('the connector');
	const busy = pending !== null;
	const target = type === 'stdio' ? command.trim() : url.trim();

	function submit(event: FormEvent) {
		event.preventDefault();

		void act('add', async () => {
			const added = await addConnector({
				name: name.trim(),
				transport:
					type === 'stdio'
						? {
								type,
								command: command.trim(),
								args: args.split('\n').filter((arg) => arg.trim()),
								env: secretRecord(secrets)
							}
						: { type, url: url.trim(), headers: secretRecord(secrets) }
			});

			if (added.type === 'local') onAdded(added.connector);
			setName('');
			setCommand('');
			setArgs('');
			setUrl('');
			setSecrets([]);
		});
	}

	function updateSecret(index: number, change: Partial<SecretRow>) {
		setSecrets((rows) => rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
	}

	const secretKind = type === 'stdio' ? 'variable' : 'header';

	return (
		<ConnectorCardFrame
			logo={<Plus className="text-foreground size-8 shrink-0 p-1.5" aria-hidden="true" />}
			name="Custom connector"
			summary={<ConnectorDescription>Add an MCP server by command or URL</ConnectorDescription>}
			error={error}
		>
			<form className="space-y-3 px-5 pb-5" onSubmit={submit} aria-label="Custom connector">
				<div role="group" aria-label="Connection" className="flex gap-1.5">
					{(
						[
							['stdio', 'Command'],
							['http', 'URL']
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							disabled={busy || (value === 'stdio' && !localApi)}
							aria-pressed={type === value}
							className={cn(
								'h-7 rounded-md border px-2.5 text-[12px] transition',
								type === value
									? 'border-foreground/40 bg-hover-fill-strong text-foreground'
									: 'border-border text-muted-foreground hover:text-foreground'
							)}
							onClick={() => setType(value)}
						>
							{label}
						</button>
					))}
				</div>
				<Field label="Name">
					<input
						className={inputClass}
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder="Linear"
						autoComplete="off"
						disabled={busy}
					/>
				</Field>
				{type === 'stdio' ? (
					<>
						<Field label="Command">
							<input
								className={cn(inputClass, 'font-mono')}
								value={command}
								onChange={(event) => setCommand(event.currentTarget.value)}
								placeholder="npx"
								autoComplete="off"
								spellCheck={false}
								disabled={busy}
							/>
						</Field>
						<Field label="Arguments, one per line">
							<textarea
								className={cn(inputClass, 'h-auto py-2 font-mono')}
								rows={3}
								value={args}
								onChange={(event) => setArgs(event.currentTarget.value)}
								placeholder={'-y\n@modelcontextprotocol/server-everything'}
								spellCheck={false}
								disabled={busy}
							/>
						</Field>
					</>
				) : (
					<Field label="URL" hint="Use HTTPS, except for localhost.">
						<input
							className={cn(inputClass, 'font-mono')}
							value={url}
							onChange={(event) => setUrl(event.currentTarget.value)}
							placeholder="http://127.0.0.1:3000/mcp"
							autoComplete="off"
							spellCheck={false}
							disabled={busy}
						/>
					</Field>
				)}
				<fieldset className="space-y-2" disabled={busy}>
					<legend className="text-foreground mb-1.5 text-[12px]">
						{type === 'stdio' ? 'Environment variables' : 'Headers'}
					</legend>
					{secrets.map((row, index) => (
						<div key={index} className="flex gap-2">
							<input
								className={cn(inputClass, 'font-mono')}
								value={row.name}
								onChange={(event) => updateSecret(index, { name: event.currentTarget.value })}
								aria-label={`${secretKind} ${index + 1} name`}
								placeholder={type === 'stdio' ? 'API_KEY' : 'Authorization'}
								autoComplete="off"
								spellCheck={false}
							/>
							<input
								className={cn(inputClass, 'font-mono')}
								type="password"
								value={row.value}
								onChange={(event) => updateSecret(index, { value: event.currentTarget.value })}
								aria-label={`${secretKind} ${index + 1} value`}
								placeholder="Value"
								autoComplete="off"
							/>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground hover:bg-hover-fill flex size-9 shrink-0 items-center justify-center rounded-lg transition"
								aria-label={`Remove ${secretKind} ${index + 1}`}
								onClick={() => setSecrets((rows) => rows.filter((_, at) => at !== index))}
							>
								<X className="size-3.5" aria-hidden="true" />
							</button>
						</div>
					))}
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[12px] transition"
						onClick={() => setSecrets((rows) => [...rows, { name: '', value: '' }])}
					>
						<Plus className="size-3.5" aria-hidden="true" />
						Add {secretKind}
					</button>
				</fieldset>
				<div className="flex justify-end">
					<button
						type="submit"
						className={primaryButtonClass}
						disabled={busy || !name.trim() || !target}
					>
						Add connector
					</button>
				</div>
			</form>
		</ConnectorCardFrame>
	);
}

export function RequestedConnectorSetup({
	userId,
	localApi,
	connector,
	onConnected
}: {
	userId: string;
	localApi: McpApi | null;
	connector: RequestedMcpConnector;
	onConnected: () => void;
}) {
	const addConnector = useAddMcpConnector(userId, localApi);
	const remoteServers = useQuery(api.mcpServers.listMine, connector.type === 'http' ? {} : 'skip');
	const [addedRemoteId, setAddedRemoteId] = useState<string | null>(null);
	const requestedUrl = connector.type === 'http' ? normalizedMcpUrl(connector.url) : null;

	const remote = remoteServers?.find((server) =>
		addedRemoteId ? server.connectorId === addedRemoteId : server.url === requestedUrl
	);

	const names = secretNames(connector);
	const [values, setValues] = useState<Record<string, string>>({});
	const { pending, error, act } = useConnectorAction<'connect'>(connector.name);
	const busy = pending !== null;

	function submit(event: FormEvent) {
		event.preventDefault();
		const secrets = Object.fromEntries(names.map((name) => [name, values[name] ?? '']));

		void act('connect', async () => {
			const added = await addConnector({
				name: connector.name,
				transport:
					connector.type === 'stdio'
						? { type: 'stdio', command: connector.command, args: connector.args, env: secrets }
						: { type: 'http', url: connector.url, headers: secrets }
			});

			if (added.type === 'remote') setAddedRemoteId(added.connectorId);
			else onConnected();
		});
	}

	if (remote) {
		return (
			<McpConnectorCard
				userId={userId}
				localApi={localApi}
				connector={remoteMcpConnector(remote)}
				remote={remote}
				onConnected={onConnected}
				onRemoved={() => setAddedRemoteId(null)}
			/>
		);
	}

	return (
		<ConnectorCardFrame
			logo={<McpLogo />}
			name={connector.name}
			summary={
				<ConnectorDescription>
					{connector.type === 'stdio'
						? 'Runs this command on your computer'
						: 'Connects to this URL'}
				</ConnectorDescription>
			}
			error={error}
		>
			<form
				className="space-y-3 px-5 pb-5"
				onSubmit={submit}
				aria-label={`Connect ${connector.name}`}
			>
				<pre className="bg-hover-fill/60 text-foreground overflow-x-auto rounded-lg px-3 py-2 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap">
					{transportLine(connector)}
				</pre>
				{names.map((name) => (
					<Field key={name} label={name} mono>
						<input
							className={cn(inputClass, 'font-mono')}
							type="password"
							value={values[name] ?? ''}
							onChange={(event) => {
								const { value } = event.currentTarget;
								setValues((current) => ({ ...current, [name]: value }));
							}}
							required
							autoComplete="off"
							disabled={busy}
						/>
					</Field>
				))}
				{names.length > 0 && (
					<p className="text-muted-foreground text-[12px]">The agent never sees these values.</p>
				)}
				<div className="flex justify-end">
					<button
						type="submit"
						className={primaryButtonClass}
						disabled={busy || addedRemoteId !== null}
					>
						Connect
					</button>
				</div>
			</form>
		</ConnectorCardFrame>
	);
}

export function RequestedRemoteConnectorSetup({
	userId,
	localApi,
	connectorId,
	onConnected
}: {
	userId: string;
	localApi: McpApi | null;
	connectorId: string;
	onConnected: () => void;
}) {
	const servers = useQuery(api.mcpServers.listMine, {});

	const remote = servers?.find((server) => remoteMcpConnector(server).id === connectorId);

	if (!remote) {
		return (
			<p className="text-muted-foreground text-[13px]">
				{servers === undefined
					? 'Checking connector…'
					: 'This connector was removed. Add it again in Settings → Connectors.'}
			</p>
		);
	}

	return (
		<McpConnectorCard
			userId={userId}
			localApi={localApi}
			connector={remoteMcpConnector(remote)}
			remote={remote}
			catalog={catalogConnector(remote.catalogId)}
			onConnected={onConnected}
		/>
	);
}

function Field({
	label,
	hint,
	mono = false,
	children
}: {
	label: string;
	hint?: string;
	mono?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<label className="block space-y-1.5">
				<span className={cn('text-foreground block text-[12px]', mono && 'font-mono')}>
					{label}
				</span>
				{children}
			</label>
			{hint && <span className="text-muted-foreground block text-[12px]">{hint}</span>}
		</div>
	);
}
