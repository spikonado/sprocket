import { useState, type ReactNode } from 'react';
import { ChevronLeft, Plus } from 'lucide-react';
import { catalogConnector, connectorCatalog, type CatalogConnector } from '$lib/connectors/catalog';
import type { McpConnector } from '$lib/types/sprocket';
import { cn } from '$lib/utils';
import { ConnectorRow, ConnectorTile, inputClass, secondaryButtonClass } from './connector-parts';
import GitHubConnector, { GitHubRow, type GitHubApi } from './github-connector';
import KiCadConnector, {
	KiCadLogo,
	kicadDescription,
	kicadState,
	type KiCadApi
} from './kicad-connector';
import {
	CatalogConnectorSetup,
	CustomConnectorForm,
	McpConnectorPanel,
	McpLogo,
	RemoteConnectorSetup,
	localState,
	remoteState,
	transportLine,
	useMcpConnectorList,
	type McpApi
} from './mcp-connectors';
import { REMOTE_MCP_PREFIX, remoteMcpConnector } from './mcp-connectors-client';
import { useConnectors } from './use-connectors';
import VercelConnector, { VercelRow, type VercelApi } from './vercel-connector';

export type ConnectorsApi = GitHubApi & VercelApi & KiCadApi & McpApi;

type Selection =
	| { type: 'github' | 'vercel' | 'kicad' | 'custom' }
	| { type: 'local'; connector: McpConnector }
	| { type: 'remote'; connectorId: string }
	| { type: 'catalog'; entry: CatalogConnector };

export default function SettingsConnectors({
	userId,
	localApi
}: {
	userId: string;
	localApi: ConnectorsApi | null;
}) {
	const [selection, setSelection] = useState<Selection | null>(null);
	const back = () => setSelection(null);

	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				{selection ? (
					<button
						type="button"
						aria-label="Back to connectors"
						className="text-muted-foreground hover:text-foreground -ml-1.5 inline-flex items-center gap-1 text-[13px] transition"
						onClick={back}
					>
						<ChevronLeft className="size-4" aria-hidden="true" />
						Connectors
					</button>
				) : (
					<h1 className="text-foreground text-[1rem] tracking-[-0.03em]">Connectors</h1>
				)}
			</header>

			<div
				key={selection ? 'detail' : 'list'}
				className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-10"
			>
				<div className="max-w-2xl">
					{selection ? (
						<ConnectorDetail
							userId={userId}
							localApi={localApi}
							selection={selection}
							onSelect={setSelection}
							onRemoved={back}
						/>
					) : (
						<ConnectorList userId={userId} localApi={localApi} onSelect={setSelection} />
					)}
				</div>
			</div>
		</section>
	);
}

function ConnectorList({
	userId,
	localApi,
	onSelect
}: {
	userId: string;
	localApi: ConnectorsApi | null;
	onSelect: (selection: Selection) => void;
}) {
	const mcp = useMcpConnectorList(userId, localApi);
	const { connectors, loadError } = useConnectors(userId, localApi);
	const kicad = connectors?.find((entry) => entry.id === 'kicad');
	const kicadAdded = kicad !== undefined && kicad.state !== 'notInstalled';
	const [query, setQuery] = useState('');
	const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

	const matches = (...text: string[]) =>
		keywords.every((keyword) => text.join(' ').toLowerCase().includes(keyword));

	const addedCatalogIds = new Set(mcp.remote?.map((server) => server.catalogId));

	const availableCatalog =
		mcp.remote === undefined
			? []
			: connectorCatalog.filter(
					(entry) =>
						!addedCatalogIds.has(entry.id) && matches(entry.id, entry.name, entry.description)
				);

	const showKiCadTile = kicad?.state === 'notInstalled' && matches('kicad', kicadDescription);
	const errors = [mcp.loadError, loadError].filter(Boolean);

	return (
		<div className="space-y-8">
			<ListSection title="Your connectors">
				{!localApi && (
					<p className="text-muted-foreground mb-3 text-[13px] leading-5">
						Open Sprocket on your computer to manage GitHub, Vercel, KiCad, and MCP servers that run
						there.
					</p>
				)}
				<ul className="border-border divide-border divide-y overflow-hidden rounded-xl border empty:hidden">
					{localApi && (
						<>
							<GitHubRow
								userId={userId}
								localApi={localApi}
								onOpen={() => onSelect({ type: 'github' })}
							/>
							<VercelRow
								userId={userId}
								localApi={localApi}
								onOpen={() => onSelect({ type: 'vercel' })}
							/>
						</>
					)}
					{kicadAdded && (
						<ConnectorRow
							logo={<KiCadLogo />}
							name="KiCad"
							detail={kicad.kicadVersion ? `KiCad ${kicad.kicadVersion}` : kicadDescription}
							state={kicadState(kicad)}
							onOpen={() => onSelect({ type: 'kicad' })}
						/>
					)}
					{mcp.local?.map((connector) => (
						<ConnectorRow
							key={connector.id}
							logo={<McpLogo />}
							name={connector.name}
							detail={<span className="font-mono">{transportLine(connector.transport)}</span>}
							state={localState}
							onOpen={() => onSelect({ type: 'local', connector })}
						/>
					))}
					{mcp.remote?.map((server) => {
						const catalog = catalogConnector(server.catalogId);
						const { id } = remoteMcpConnector(server);

						return (
							<ConnectorRow
								key={id}
								logo={<McpLogo iconUrl={catalog?.iconUrl} />}
								name={server.name}
								detail={catalog?.description ?? server.url}
								state={remoteState(server)}
								onOpen={() => onSelect({ type: 'remote', connectorId: id })}
							/>
						);
					})}
				</ul>
				{errors.map((error) => (
					<p key={error} role="alert" className="text-destructive mt-2 text-[12px]">
						{error}
					</p>
				))}
			</ListSection>

			<ListSection title="Add a connector">
				<div className="flex flex-wrap gap-2">
					<input
						type="search"
						className={cn(inputClass, 'min-w-56 flex-1')}
						aria-label="Search connectors"
						placeholder={`Search ${connectorCatalog.length} connectors`}
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
					/>
					<button
						type="button"
						className={`${secondaryButtonClass} h-9`}
						onClick={() => onSelect({ type: 'custom' })}
					>
						<Plus className="size-3.5" aria-hidden="true" />
						Custom MCP server
					</button>
				</div>
				<ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Available connectors">
					{showKiCadTile && (
						<ConnectorTile
							logo={<KiCadLogo />}
							name="KiCad"
							description={kicadDescription}
							onOpen={() => onSelect({ type: 'kicad' })}
						/>
					)}
					{availableCatalog.map((entry) => (
						<ConnectorTile
							key={entry.id}
							logo={<McpLogo iconUrl={entry.iconUrl} />}
							name={entry.name}
							description={entry.description}
							onOpen={() => onSelect({ type: 'catalog', entry })}
						/>
					))}
				</ul>
				{!showKiCadTile && availableCatalog.length === 0 && (
					<p className="text-muted-foreground text-[13px]">
						No connectors match your search. Add it as a custom MCP server instead.
					</p>
				)}
			</ListSection>
		</div>
	);
}

function ListSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section aria-label={title}>
			<h2 className="text-muted-foreground mb-2 text-[11px] tracking-[0.06em] uppercase">
				{title}
			</h2>
			{children}
		</section>
	);
}

function ConnectorDetail({
	userId,
	localApi,
	selection,
	onSelect,
	onRemoved
}: {
	userId: string;
	localApi: ConnectorsApi | null;
	selection: Selection;
	onSelect: (selection: Selection) => void;
	onRemoved: () => void;
}) {
	switch (selection.type) {
		case 'local':
			return (
				<McpConnectorPanel
					userId={userId}
					localApi={localApi}
					connector={selection.connector}
					onRemoved={onRemoved}
				/>
			);
		case 'remote':
			return (
				<RemoteConnectorSetup
					userId={userId}
					localApi={localApi}
					connectorId={selection.connectorId}
					onRemoved={onRemoved}
				/>
			);
		case 'catalog':
			return (
				<CatalogConnectorSetup
					userId={userId}
					localApi={localApi}
					entry={selection.entry}
					onRemoved={onRemoved}
				/>
			);
		case 'custom':
			return (
				<CustomConnectorForm
					userId={userId}
					localApi={localApi}
					onAdded={(added) =>
						onSelect(
							added.type === 'local'
								? { type: 'local', connector: added.connector }
								: { type: 'remote', connectorId: `${REMOTE_MCP_PREFIX}${added.connectorId}` }
						)
					}
				/>
			);
	}

	if (!localApi) {
		return (
			<p className="text-muted-foreground text-[13px]">
				Open Sprocket on your computer to manage this connector.
			</p>
		);
	}

	switch (selection.type) {
		case 'github':
			return <GitHubConnector userId={userId} localApi={localApi} />;
		case 'vercel':
			return <VercelConnector userId={userId} localApi={localApi} />;
		case 'kicad':
			return <KiCadConnector userId={userId} localApi={localApi} />;
	}
}
