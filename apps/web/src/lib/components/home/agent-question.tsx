import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import {
	AGENT_DECIDE_OPTION_ID,
	CONNECTED_OPTION_ID,
	type AgentQuestionDetail,
	type AgentQuestionOption
} from '@convex/lib/agentQuestions';
import GitHubConnector from './github-connector';
import KiCadConnector from './kicad-connector';
import {
	RequestedCatalogConnectorSetup,
	RequestedConnectorSetup,
	RequestedRemoteConnectorSetup
} from './mcp-connectors';
import { catalogConnector } from '$lib/connectors/catalog';
import { REMOTE_MCP_PREFIX } from './mcp-connectors-client';
import type { ConnectorsApi } from './settings-connectors';
import VercelConnector from './vercel-connector';

export type QuestionConnectorSetup = { userId: string; localApi: ConnectorsApi | null };

type Props = {
	question: string;
	options: AgentQuestionOption[];
	detail?: AgentQuestionDetail;
	runEnded: boolean;
	selectedOptionId: string | null;
	onToggleOption: (optionId: string) => void;
	onAnswer: (optionId: string) => void;
	connectorSetup: QuestionConnectorSetup | null;
};

export default function AgentQuestion({
	question,
	options,
	detail,
	runEnded,
	selectedOptionId,
	onToggleOption,
	onAnswer,
	connectorSetup
}: Props) {
	const [expanded, setExpanded] = useState(!runEnded);
	const [previousRunEnded, setPreviousRunEnded] = useState(runEnded);

	if (runEnded !== previousRunEnded) {
		setPreviousRunEnded(runEnded);
		setExpanded(!runEnded);
	}

	return (
		<div className="mb-3 max-h-[40dvh] overflow-y-auto" role="group" aria-label="Agent question">
			<div className="text-foreground flex items-start gap-1.5 text-[14px] leading-6">
				<span
					className={`min-w-0 flex-1 ${expanded ? '' : 'cursor-pointer truncate'}`}
					onClick={expanded ? undefined : () => setExpanded(true)}
				>
					{question}
				</span>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground hover:bg-hover-fill focus-visible:ring-ring mt-0.5 shrink-0 cursor-pointer rounded p-0.5 transition focus-visible:ring-2 focus-visible:outline-none"
					aria-label={expanded ? 'Collapse question' : 'Expand question'}
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					<ChevronRight
						className={`size-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
						aria-hidden="true"
					/>
				</button>
			</div>
			{expanded && detail?.type === 'approval' && <ApprovalDetail detail={detail} />}
			{expanded && detail?.type === 'connector' && (
				<ConnectorRequest
					detail={detail}
					setup={connectorSetup}
					onConnected={() => onAnswer(CONNECTED_OPTION_ID)}
				/>
			)}
			{expanded && detail?.type !== 'connector' ? (
				<ul className="mt-2 flex flex-col gap-1.5" aria-label="Answer options">
					{options.map((option) => {
						const isAgentDecide = option.id === AGENT_DECIDE_OPTION_ID;
						const isSelected = selectedOptionId === option.id;

						return (
							<li key={option.id}>
								<button
									type="button"
									className={`w-full rounded-lg border px-3 py-2 text-left text-[13px] leading-5 transition ${
										isSelected
											? 'border-foreground/40 bg-hover-fill-strong text-foreground'
											: isAgentDecide
												? 'border-border/70 text-muted-foreground/80 hover:text-muted-foreground hover:bg-hover-fill'
												: 'border-border text-muted-foreground hover:text-foreground hover:bg-hover-fill'
									}`}
									aria-pressed={isSelected}
									onClick={() => onToggleOption(option.id)}
								>
									{option.label}
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
		</div>
	);
}

function prettyJson(text: string) {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function ApprovalDetail({
	detail
}: {
	detail: Extract<AgentQuestionDetail, { type: 'approval' }>;
}) {
	return (
		<div className="border-border mt-2 rounded-lg border text-[13px]">
			<p className="text-muted-foreground px-3 pt-2">
				<span className="text-foreground">{detail.connector}</span> ·{' '}
				<span className="text-foreground font-mono">{detail.tool}</span>
			</p>
			<details className="group px-3 py-2">
				<summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 text-[12px]">
					<ChevronRight
						className="size-3.5 transition-transform group-open:rotate-90"
						aria-hidden="true"
					/>
					Arguments
				</summary>
				<pre className="bg-hover-fill/60 text-foreground mt-2 max-h-48 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-5">
					{prettyJson(detail.arguments)}
				</pre>
			</details>
		</div>
	);
}

function ConnectorRequest({
	detail,
	setup,
	onConnected
}: {
	detail: Extract<AgentQuestionDetail, { type: 'connector' }>;
	setup: QuestionConnectorSetup | null;
	onConnected: () => void;
}) {
	const { connector } = detail;
	const catalog = connector.type === 'known' ? catalogConnector(connector.id) : undefined;

	const openSprocket = (
		<p className="text-muted-foreground text-[13px]">
			Open Sprocket on the computer running this agent to set up the connector.
		</p>
	);

	return (
		<div className="mt-2 space-y-3">
			{!setup ? (
				openSprocket
			) : connector.type !== 'known' ? (
				<RequestedConnectorSetup
					userId={setup.userId}
					localApi={setup.localApi}
					connector={connector}
					onConnected={onConnected}
				/>
			) : catalog ? (
				<RequestedCatalogConnectorSetup
					userId={setup.userId}
					localApi={setup.localApi}
					entry={catalog}
					onConnected={onConnected}
				/>
			) : connector.id.startsWith(REMOTE_MCP_PREFIX) ? (
				<RequestedRemoteConnectorSetup
					userId={setup.userId}
					localApi={setup.localApi}
					connectorId={connector.id}
					onConnected={onConnected}
				/>
			) : !setup.localApi ? (
				openSprocket
			) : connector.id === 'github' ? (
				<GitHubConnector
					userId={setup.userId}
					localApi={setup.localApi}
					onConnected={onConnected}
				/>
			) : connector.id === 'vercel' ? (
				<VercelConnector
					userId={setup.userId}
					localApi={setup.localApi}
					onConnected={onConnected}
				/>
			) : connector.id === 'kicad' ? (
				<KiCadConnector userId={setup.userId} localApi={setup.localApi} onConnected={onConnected} />
			) : (
				<p className="text-muted-foreground text-[13px]">
					This version of Sprocket can’t set up “{connector.id}”.
				</p>
			)}
		</div>
	);
}
