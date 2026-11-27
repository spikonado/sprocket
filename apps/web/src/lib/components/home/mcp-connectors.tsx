import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronRight, Plug, Plus, X } from 'lucide-react';
import type { AgentQuestionDetail } from '@convex/lib/agentQuestions';
import { cn } from '$lib/utils';
import type { LocalApi, McpConnector, McpTool, ToolPolicy } from '$lib/types/sprocket';
import {
	ConnectorCardFrame,
	ConnectorDescription,
	inputClass,
	primaryButtonClass,
	secondaryButtonClass,
	useConnectorAction
} from './connector-card-parts';
import { caughtMessage, usePolledStatus } from './use-connectors';

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

function McpLogo() {
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

export default function McpConnectors({ userId, localApi }: { userId: string; localApi: McpApi }) {
	const fetchConnectors = useCallback(
		() => localApi.fetchMcpConnectors(userId),
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
			{loadError && (
				<p role="alert" className="text-destructive text-sm">
					{loadError}
				</p>
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
	onRemoved
}: {
	userId: string;
	localApi: McpApi;
	connector: McpConnector;
	onRemoved: () => void;
}) {
	const [open, setOpen] = useState(false);
	const { pending, error, act } = useConnectorAction<'remove'>(connector.name);
	const line = transportLine(connector.transport);
	const secrets = secretNames(connector.transport);

	return (
		<ConnectorCardFrame
			logo={<McpLogo />}
			name={connector.name}
			summary={
				<>
					<p className="text-muted-foreground mt-0.5 truncate font-mono text-[12px]" title={line}>
						{line}
					</p>
					{secrets.length > 0 && (
						<p className="text-muted-foreground mt-0.5 truncate text-[12px]">
							{connector.transport.type === 'stdio' ? 'Environment' : 'Headers'}:{' '}
							<span className="font-mono">{secrets.join(', ')}</span>
						</p>
					)}
				</>
			}
			actions={
				<>
					<button
						type="button"
						className={secondaryButtonClass}
						aria-expanded={open}
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
								await localApi.removeMcpConnector(userId, connector.id);
								onRemoved();
							})
						}
					>
						Remove
					</button>
				</>
			}
			error={error}
		>
			{open && <McpToolList userId={userId} localApi={localApi} connectorId={connector.id} />}
		</ConnectorCardFrame>
	);
}

function McpToolList({
	userId,
	localApi,
	connectorId
}: {
	userId: string;
	localApi: McpApi;
	connectorId: string;
}) {
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
		withPolicy(tool.name, policy);
		setSaveError(null);

		try {
			await localApi.setMcpToolPolicy(userId, connectorId, tool.name, policy);
		} catch (caught) {
			withPolicy(tool.name, tool.policy);
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
								value={tool.policy}
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
	localApi: McpApi;
	onAdded: (connector: McpConnector) => void;
}) {
	const [type, setType] = useState<'stdio' | 'http'>('stdio');
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
			const added = await localApi.addMcpConnector(userId, {
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

			onAdded(added);
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
			summary={
				<ConnectorDescription>
					Add an MCP server that runs as a command or listens on this computer
				</ConnectorDescription>
			}
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
					<Field label="URL" hint="Only servers on this computer (localhost) for now.">
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
	localApi: Pick<LocalApi, 'addMcpConnector'>;
	connector: RequestedMcpConnector;
	onConnected: () => void;
}) {
	const names = secretNames(connector);
	const [values, setValues] = useState<Record<string, string>>({});
	const { pending, error, act } = useConnectorAction<'connect'>(connector.name);
	const busy = pending !== null;

	function submit(event: FormEvent) {
		event.preventDefault();
		const secrets = Object.fromEntries(names.map((name) => [name, values[name] ?? '']));

		void act('connect', async () => {
			await localApi.addMcpConnector(userId, {
				name: connector.name,
				transport:
					connector.type === 'stdio'
						? { type: 'stdio', command: connector.command, args: connector.args, env: secrets }
						: { type: 'http', url: connector.url, headers: secrets }
			});
			onConnected();
		});
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
					<p className="text-muted-foreground text-[12px]">
						These values stay on this computer. The agent never sees them.
					</p>
				)}
				<div className="flex justify-end">
					<button type="submit" className={primaryButtonClass} disabled={busy}>
						Connect
					</button>
				</div>
			</form>
		</ConnectorCardFrame>
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
