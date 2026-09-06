import { isJsonObject, type JsonValue } from '$convex/lib/json';
import {
	assistantTimelineToolError,
	isAssistantTimelineToolRunning,
	resolveCommandSessionLabel,
	type AssistantTimelineTool
} from '$lib/chat/assistant-timeline';
import { jsonString } from '$lib/chat/json-fields';

function titleizeSnakeCase(value: string) {
	return value
		.split('_')
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(' ');
}

export function toolGroupLabel(toolKey: string) {
	switch (toolKey) {
		case 'apply_patch':
			return 'Changed Files';
		case 'ask_question':
			return 'Asked Questions';
		case 'await_question':
			return 'Waiting for Answers';
		case 'check_docs':
			return 'Checked Docs';
		case 'create_artifact':
			return 'Created Artifacts';
		case 'exec_command':
			return 'Ran Commands';
		case 'get_workspace_instructions':
			return 'Read Instructions';
		case 'mandate_charge':
			return 'Charged Card';
		case 'mandate_list':
			return 'Listed Mandates';
		case 'mandate_report':
			return 'Settled Charges';
		case 'mandate_setup':
			return 'Set Up Mandate';
		case 'mandate_status':
			return 'Checked Mandate';
		case 'read_skill':
			return 'Read Skill';
		case 'parse_file':
			return 'Parsed Files';
		case 'scrape_url':
			return 'Read Pages';
		case 'update_artifact':
			return 'Updated Artifacts';
		case 'web_search':
			return 'Searched Web';
		case 'write_stdin':
			return 'Monitored Commands';
		default:
			return titleizeSnakeCase(toolKey);
	}
}

function describeExecCommandOptions(input: JsonValue | undefined) {
	if (!isJsonObject(input)) {
		return '';
	}

	const details: string[] = [];
	const workdir = jsonString(input.workdir);
	if (workdir && workdir.trim().length > 0 && workdir !== '.') {
		details.push(`cwd ${workdir}`);
	}

	return details.length > 0 ? ` (${details.join(', ')})` : '';
}

/** Detail line for a tool row; no type prefix (that lives on the dropdown label). */
function summarizeTool(name: string, input: JsonValue | undefined) {
	const fields = isJsonObject(input) ? input : undefined;

	switch (name) {
		case 'apply_patch':
			return summarizePatchInput(input) ?? 'Patch';
		case 'ask_question':
			return jsonString(fields?.question) ?? 'Question';
		case 'await_question':
			return 'Waiting for answer';
		case 'check_docs':
			return jsonString(fields?.query) ?? jsonString(fields?.path) ?? 'Docs';
		case 'create_artifact':
			return jsonString(fields?.title) ?? 'Artifact';
		case 'exec_command': {
			const cmd = jsonString(fields?.cmd);
			return cmd ? `${cmd}${describeExecCommandOptions(input)}` : 'Command';
		}
		case 'get_workspace_instructions':
			return 'Workspace instructions';
		case 'mandate_charge':
			return summarizeMandateCharge(fields);
		case 'mandate_list':
			return 'Standing mandates';
		case 'mandate_report':
			return fields?.outcome === 'approved' ? 'Charge approved' : 'Charge declined';
		case 'mandate_setup':
			return summarizeMandateSetup(fields);
		case 'mandate_status':
			return 'Mandate status';
		case 'read_skill': {
			const name = jsonString(fields?.name);
			return name ? `$${name}` : 'Skill';
		}
		case 'scrape_url':
			return jsonString(fields?.url) ?? 'Web page';
		case 'parse_file':
			return jsonString(fields?.path) ?? jsonString(fields?.url) ?? 'File';
		case 'update_artifact':
			return 'Updated artifact';
		case 'web_search':
			return jsonString(fields?.query) ?? 'Web search';
		case 'write_stdin': {
			const sessionId = jsonString(fields?.sessionId);
			return sessionId ? `Session ${sessionId}` : 'Command session';
		}
		default:
			return titleizeSnakeCase(name);
	}
}

/** Patch summaries list one path per line; give them room to wrap instead of truncating. */
export function toolSummaryClass(toolLog: AssistantTimelineTool) {
	return (toolLog.job?.kind ?? toolLog.name) === 'apply_patch'
		? 'whitespace-pre-wrap [overflow-wrap:anywhere]'
		: 'truncate';
}

/** "Merchant · 120.00 USD monthly" from a mandate setup payload. */
function summarizeMandateSetup(fields: Record<string, JsonValue> | undefined) {
	const merchant = jsonString(fields?.merchantName) ?? 'Any merchant';
	const cap = jsonString(fields?.amountCap);
	const currency = jsonString(fields?.currency) ?? '';
	const frequency = jsonString(fields?.frequency) ?? '';
	const amount = cap ? ` · ${cap} ${currency}`.trimEnd() : '';
	const cycle = frequency && frequency !== 'one_time' ? ` ${frequency}` : '';
	return `${merchant}${amount}${cycle}`;
}

/** "Merchant charge · 40.00 USD" from a mandate charge payload. */
function summarizeMandateCharge(fields: Record<string, JsonValue> | undefined) {
	const description = jsonString(fields?.description) ?? 'Charge';
	const amount = jsonString(fields?.amount);
	const currency = jsonString(fields?.currency) ?? '';
	return amount ? `${description} · ${amount} ${currency}`.trimEnd() : description;
}

const PATCH_ENVELOPE_FILE_HEADERS = [
	'*** Add File: ',
	'*** Copy File: ',
	'*** Delete File: ',
	'*** Update File: '
];
const PATCH_ENVELOPE_DESTINATION_HEADERS = ['*** Copy to: ', '*** Move to: '];

function gitDiffPath(line: string) {
	const quotedMarker = ' "b/';
	const marker = line.lastIndexOf(quotedMarker);
	if (marker >= 0) {
		return line.slice(marker + quotedMarker.length).replace(/"$/, '');
	}
	const plainMarker = ' b/';
	const plainMarkerIndex = line.lastIndexOf(plainMarker);
	return plainMarkerIndex >= 0 ? line.slice(plainMarkerIndex + plainMarker.length) : null;
}

function summarizePatchInput(input: JsonValue | undefined) {
	const patch = isJsonObject(input) ? jsonString(input.patch) : undefined;
	if (!patch) {
		return null;
	}

	const paths: string[] = [];
	for (const line of patch.split('\n')) {
		if (line.startsWith('diff --git ')) {
			const path = gitDiffPath(line);
			if (path !== null) {
				paths.push(path);
			}
			continue;
		}
		const fileHeader = PATCH_ENVELOPE_FILE_HEADERS.find((header) => line.startsWith(header));
		if (fileHeader) {
			paths.push(line.slice(fileHeader.length).trim());
			continue;
		}
		const destinationHeader = PATCH_ENVELOPE_DESTINATION_HEADERS.find((header) =>
			line.startsWith(header)
		);
		if (destinationHeader && paths.length > 0) {
			// A rename or copy: report the destination, matching the applied-patch result.
			paths[paths.length - 1] = line.slice(destinationHeader.length).trim();
		}
	}
	const uniquePaths = [...new Set(paths)];
	return uniquePaths.length > 0 ? uniquePaths.join('\n') : null;
}

function summarizePatchResult(result: JsonValue | undefined) {
	if (!isJsonObject(result) || !Array.isArray(result.changes)) {
		return null;
	}

	const paths = result.changes.flatMap((change) => {
		if (!isJsonObject(change)) {
			return [];
		}
		const path = jsonString(change.path);
		return path ? [path] : [];
	});
	if (paths.length === 0) {
		return null;
	}
	return [...new Set(paths)].join('\n');
}

function patchSummary(toolLog: AssistantTimelineTool) {
	if (toolLog.job?.kind === 'apply_patch') {
		return summarizePatchResult(toolLog.job.result) ?? summarizePatchInput(toolLog.job.payload);
	}
	return toolLog.name === 'apply_patch' ? summarizePatchInput(toolLog.input) : null;
}

export function changedFileCount(tools: AssistantTimelineTool[]) {
	return new Set(tools.flatMap((tool) => patchSummary(tool)?.split('\n') ?? [])).size;
}

function summarizeWebToolResult(kind: string, result: JsonValue | undefined) {
	if (kind === 'web_search' && isJsonObject(result) && Array.isArray(result.results)) {
		const count = result.results.length;
		return ` (${count} result${count === 1 ? '' : 's'})`;
	}
	if (kind === 'scrape_url' && isJsonObject(result) && result.truncated === true) {
		return ' (truncated)';
	}
	return '';
}

export function toolItemSummary(
	toolLog: AssistantTimelineTool,
	sessionCommands: ReadonlyMap<string, string>
) {
	const kind = toolLog.job?.kind ?? toolLog.name;
	if (kind === 'write_stdin') {
		return (
			resolveCommandSessionLabel(toolLog, sessionCommands) ??
			summarizeTool('write_stdin', toolLog.job?.payload ?? toolLog.input)
		);
	}
	if (toolLog.job) {
		const summary = patchSummary(toolLog);
		if (summary) {
			return summary;
		}
		return (
			summarizeTool(toolLog.job.kind, toolLog.job.payload) +
			summarizeWebToolResult(toolLog.job.kind, toolLog.job.result)
		);
	}
	return summarizeTool(toolLog.name, toolLog.input);
}

export function fullToolSummary(
	toolLog: AssistantTimelineTool,
	isStreaming: boolean,
	sessionCommands: ReadonlyMap<string, string>
) {
	const summary = toolItemSummary(toolLog, sessionCommands);
	if (isAssistantTimelineToolRunning(toolLog, isStreaming)) {
		return `${summary} (running)`;
	}
	const error = assistantTimelineToolError(toolLog, isStreaming);
	return error ? `${summary} (${error})` : summary;
}
