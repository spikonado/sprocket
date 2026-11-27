import { ChevronRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
	AGENT_DECIDE_OPTION_ID,
	CONNECTED_OPTION_ID,
	formValuesError,
	type AgentQuestionDetail,
	type AgentQuestionOption,
	type QuestionFormField,
	type QuestionValues
} from '@convex/lib/agentQuestions';
import { cn } from '$lib/utils';
import { inputClass, primaryButtonClass } from './connector-card-parts';
import GitHubConnector from './github-connector';
import KiCadConnector from './kicad-connector';
import { RequestedConnectorSetup } from './mcp-connectors';
import type { ConnectorsApi } from './settings-connectors';
import VercelConnector from './vercel-connector';

export type QuestionAnswerInput = { optionId?: string; values?: QuestionValues };

export type QuestionConnectorSetup = { userId: string; localApi: ConnectorsApi };

type Props = {
	question: string;
	options: AgentQuestionOption[];
	detail?: AgentQuestionDetail;
	runEnded: boolean;
	selectedOptionId: string | null;
	onToggleOption: (optionId: string) => void;
	onAnswer: (answer: QuestionAnswerInput) => void;
	connectorSetup: QuestionConnectorSetup | null;
	disabled: boolean;
};

export default function AgentQuestion({
	question,
	options,
	detail,
	runEnded,
	selectedOptionId,
	onToggleOption,
	onAnswer,
	connectorSetup,
	disabled
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
			{expanded && detail?.type === 'form' && (
				<QuestionForm
					fields={detail.fields}
					disabled={disabled}
					onSubmit={(values) => onAnswer({ values })}
				/>
			)}
			{expanded && detail?.type === 'connector' && (
				<ConnectorRequest
					detail={detail}
					setup={connectorSetup}
					onConnected={() => onAnswer({ optionId: CONNECTED_OPTION_ID })}
				/>
			)}
			{expanded && (detail === undefined || detail.type === 'approval') ? (
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

function ApprovalDetail({ detail }: { detail: Extract<AgentQuestionDetail, { type: 'approval' }> }) {
	return (
		<div className="border-border mt-2 rounded-lg border text-[13px]">
			<p className="text-muted-foreground px-3 pt-2">
				<span className="text-foreground">{detail.connector}</span> ·{' '}
				<span className="text-foreground font-mono">{detail.tool}</span>
			</p>
			<details className="group px-3 py-2">
				<summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 text-[12px]">
					<ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
					Arguments
				</summary>
				<pre className="bg-hover-fill/60 text-foreground mt-2 max-h-48 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-5">
					{prettyJson(detail.arguments)}
				</pre>
			</details>
		</div>
	);
}

const CHECKED = 'true';

type RawFormValues = Record<string, string>;

function initialFormValues(fields: QuestionFormField[]): RawFormValues {
	return Object.fromEntries(
		fields.map((field) => [
			field.name,
			field.default === undefined || field.default === false ? '' : String(field.default)
		])
	);
}

function toFormValues(fields: QuestionFormField[], raw: RawFormValues): QuestionValues {
	const values: QuestionValues = {};

	for (const field of fields) {
		const value = raw[field.name];

		if (field.kind === 'boolean') values[field.name] = value === CHECKED;
		else if (value === '') continue;
		else if (field.kind === 'number' || field.kind === 'integer') values[field.name] = Number(value);
		else values[field.name] = value;
	}

	return values;
}

function QuestionForm({
	fields,
	disabled,
	onSubmit
}: {
	fields: QuestionFormField[];
	disabled: boolean;
	onSubmit: (values: QuestionValues) => void;
}) {
	const [raw, setRaw] = useState(() => initialFormValues(fields));
	const [error, setError] = useState<string | null>(null);

	function submit(event: FormEvent) {
		event.preventDefault();
		const values = toFormValues(fields, raw);
		const problem = formValuesError(fields, values);
		setError(problem);

		if (!problem) onSubmit(values);
	}

	function set(name: string, value: string) {
		setRaw((current) => ({ ...current, [name]: value }));
	}

	return (
		<form className="mt-2 space-y-3" onSubmit={submit} aria-label="Answer form" noValidate>
			{fields.map((field) => (
				<FormField
					key={field.name}
					field={field}
					value={raw[field.name]}
					disabled={disabled}
					onChange={(value) => set(field.name, value)}
				/>
			))}
			{error && (
				<p role="alert" className="text-destructive text-[12px]">
					{error}
				</p>
			)}
			<div className="flex justify-end">
				<button type="submit" className={primaryButtonClass} disabled={disabled}>
					Submit
				</button>
			</div>
		</form>
	);
}

function FormField({
	field,
	value,
	disabled,
	onChange
}: {
	field: QuestionFormField;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const label = (
		<span className="text-foreground text-[12px]">
			{field.title ?? field.name}
			{field.required && (
				<span className="text-muted-foreground" aria-hidden="true">
					{' '}
					*
				</span>
			)}
		</span>
	);

	const description = field.description && (
		<span className="text-muted-foreground block text-[12px] leading-5">{field.description}</span>
	);

	if (field.kind === 'boolean') {
		return (
			<label className="flex items-start gap-2">
				<input
					type="checkbox"
					className="mt-1"
					checked={value === CHECKED}
					disabled={disabled}
					onChange={(event) => onChange(event.currentTarget.checked ? CHECKED : '')}
				/>
				<span>
					{label}
					{description}
				</span>
			</label>
		);
	}

	return (
		<label className="block space-y-1">
			<span className="block">{label}</span>
			{description}
			{field.kind === 'enum' ? (
				<select
					className={inputClass}
					value={value}
					required={field.required}
					disabled={disabled}
					onChange={(event) => onChange(event.currentTarget.value)}
				>
					<option value="">Choose…</option>
					{(field.enumValues ?? []).map((option, index) => (
						<option key={option} value={option}>
							{field.enumLabels?.[index] ?? option}
						</option>
					))}
				</select>
			) : (
				<input
					className={cn(inputClass, field.kind !== 'string' && 'font-mono')}
					type={field.kind === 'string' ? 'text' : 'number'}
					step={field.kind === 'integer' ? 1 : 'any'}
					value={value}
					required={field.required}
					disabled={disabled}
					onChange={(event) => onChange(event.currentTarget.value)}
				/>
			)}
		</label>
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

	return (
		<div className="mt-2 space-y-3">
			<p className="text-muted-foreground text-[13px] leading-5">{detail.reason}</p>
			{!setup ? (
				<p className="text-muted-foreground text-[13px]">
					Open Sprocket on the computer running this agent to set up the connector.
				</p>
			) : connector.type !== 'known' ? (
				<RequestedConnectorSetup
					userId={setup.userId}
					localApi={setup.localApi}
					connector={connector}
					onConnected={onConnected}
				/>
			) : connector.id === 'github' ? (
				<GitHubConnector {...setup} onConnected={onConnected} />
			) : connector.id === 'vercel' ? (
				<VercelConnector {...setup} onConnected={onConnected} />
			) : connector.id === 'kicad' ? (
				<KiCadConnector {...setup} onConnected={onConnected} />
			) : (
				<p className="text-muted-foreground text-[13px]">
					This version of Sprocket can’t set up “{connector.id}”.
				</p>
			)}
		</div>
	);
}
