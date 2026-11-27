import GitHubConnector, { type GitHubApi } from './github-connector';
import KiCadConnector, { type KiCadApi } from './kicad-connector';
import McpConnectors, { type McpApi } from './mcp-connectors';
import VercelConnector, { type VercelApi } from './vercel-connector';

export type ConnectorsApi = GitHubApi & VercelApi & KiCadApi & McpApi;

export default function SettingsConnectors({
	userId,
	localApi
}: {
	userId: string;
	localApi: ConnectorsApi | null;
}) {
	return (
		<section className="flex h-full min-h-0 flex-col overflow-hidden">
			<header className="flex h-12 shrink-0 items-center px-6">
				<h1 className="text-foreground text-[1rem] tracking-[-0.03em]">Connectors</h1>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
				<div className="max-w-xl space-y-4">
					{!localApi ? (
						<p className="text-muted-foreground text-sm leading-6">
							Connectors are installed on the computer running Sprocket. Open Sprocket there to
							change them.
						</p>
					) : (
						<>
							<GitHubConnector userId={userId} localApi={localApi} />
							<VercelConnector userId={userId} localApi={localApi} />
							<KiCadConnector userId={userId} localApi={localApi} />
							<McpConnectors userId={userId} localApi={localApi} />
						</>
					)}
				</div>
			</div>
		</section>
	);
}
