import { isJsonObject, type JsonValue } from '@convex/lib/json';
import {
	assistantTimelineToolError,
	resolveCommandSessionLabel,
	type AssistantTimelineTool
} from '$lib/chat/assistant-timeline';
import { jsonString } from '$lib/chat/json-fields';
import { isCommandToolKind, isSessionCommandToolKind } from '$lib/chat/command-tool-kinds';

function titleizeSnakeCase(value: string) {
	return value
		.split('_')
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(' ');
}

export function toolItemLabel(toolKey: string): string | undefined {
	if (isCommandToolKind(toolKey)) return undefined;

	switch (toolKey) {
		case 'apply_patch':
		case 'ask_question':
		case 'await_question':
		case 'poll_question':
		case 'read_skill':
		case 'scrape_url':
		case 'web_search':
			return undefined;
		case 'spawn_subagent':
			return 'Delegated Tasks';
		case 'control_subagent':
			return 'Controlled Subagents';
		case 'poll_subagent':
			return 'Polled Subagents';
		case 'list_subagents':
			return 'Listed Subagents';
		case 'list_subagent_models':
			return 'Listed Subagent Models';
		case 'check_docs':
			return 'Checked Docs';
		case 'add_artifact':
		case 'create_artifact':
			return 'Created Artifact';
		case 'edit_artifact':
		case 'update_artifact':
			return 'Updated Artifact';
		case 'list_artifacts':
			return 'Listed Artifacts';
		case 'save_artifact':
			return 'Saved Artifact';
		case 'delete_artifact':
			return 'Deleted Artifact';
		case 'get_workspace_instructions':
			return 'Read Instructions';
		case 'mandate_charge':
			return 'Charged Card';
		case 'mandate_list':
			return 'Listed Mandates';
		case 'mandate_report':
			return 'Settled Charge';
		case 'mandate_setup':
			return 'Set Up Mandate';
		case 'mandate_status':
			return 'Checked Mandate';
		case 'parse_file':
			return 'Parsed File';
		case 'screenshot_url':
			return 'Captured Screenshot';
		default:
			return titleizeSnakeCase(toolKey);
	}
}

function describeExecCommandOptions(input: JsonValue | undefined) {
	const workdir = isJsonObject(input) ? jsonString(input.workdir) : undefined;

	return workdir && workdir.trim().length > 0 && workdir !== '.' ? ` (cwd ${workdir})` : '';
}

function summarizeTool(name: string, input: JsonValue | undefined) {
	const fields = isJsonObject(input) ? input : undefined;

	switch (name) {
		case 'apply_patch':
			return summarizePatchInput(input) ?? 'Patch';
		case 'ask_question':
			return jsonString(fields?.question) ?? 'Question';
		case 'await_question':
		case 'poll_question':
			return 'Waiting for answer';
		case 'spawn_subagent':
			return jsonString(fields?.prompt) ?? jsonString(fields?.threadId) ?? 'Child agent';
		case 'control_subagent':
			if (fields?.action === 'stop') return 'Stop child agent';

			if (fields?.action === 'answer_question') return 'Answer child question';

			return jsonString(fields?.threadId) ?? 'Child agent';
		case 'poll_subagent':
			return jsonString(fields?.threadId) ?? 'Child agent';
		case 'list_subagents':
			return jsonString(fields?.parentThreadId) ?? 'Child agents';
		case 'list_subagent_models':
			return 'Available subagent models';
		case 'check_docs':
			return jsonString(fields?.query) ?? jsonString(fields?.path) ?? 'Docs';
		case 'add_artifact':
		case 'create_artifact':
		case 'edit_artifact':
		case 'save_artifact':
		case 'delete_artifact':
			return summarizeArtifactTool(input);
		case 'list_artifacts':
			return 'Artifacts';
		case 'exec_command':
		case 'exec_cmd': {
			const cmd = jsonString(fields?.cmd);

			return cmd ? `${cmd}${describeExecCommandOptions(input)}` : 'Command';
		}

		case 'control_command':
		case 'control_cmd': {
			const sessionId = jsonString(fields?.sessionId);
			const session = sessionId ? `Session ${sessionId}` : 'Command session';

			return fields?.action === 'terminate' ? `Terminate ${session}` : `Write to ${session}`;
		}

		case 'poll_command':
		case 'poll_cmd':
		case 'write_stdin': {
			const sessionId = jsonString(fields?.sessionId);

			return sessionId ? `Session ${sessionId}` : 'Command session';
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
		case 'screenshot_url':
			return jsonString(fields?.url) ?? 'URL';
		case 'parse_file':
			return jsonString(fields?.path) ?? jsonString(fields?.url) ?? 'File';
		case 'update_artifact':
			return jsonString(fields?.title) ?? 'Updated artifact';
		case 'web_search':
			return jsonString(fields?.query) ?? 'Web search';
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

function summarizeArtifactTool(input: JsonValue | undefined, result?: JsonValue) {
	const fields = isJsonObject(input) ? input : undefined;
	const resultFields = isJsonObject(result) ? result : undefined;

	return (
		jsonString(fields?.path) ??
		jsonString(fields?.localPath) ??
		jsonString(resultFields?.localPath) ??
		jsonString(resultFields?.path) ??
		jsonString(resultFields?.title) ??
		jsonString(fields?.title) ??
		jsonString(fields?.artifactId) ??
		'Artifact'
	);
}

function summarizeArtifactListResult(result: JsonValue | undefined) {
	const artifacts = Array.isArray(result)
		? result
		: isJsonObject(result) && Array.isArray(result.artifacts)
			? result.artifacts
			: undefined;

	if (artifacts === undefined) {
		return 'Artifacts';
	}

	const count = artifacts.length;

	return count === 1 ? '1 artifact' : `${count} artifacts`;
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

function summarizeWebToolResult(kind: string, result: JsonValue | undefined) {
	if (kind === 'web_search' && isJsonObject(result) && Array.isArray(result.results)) {
		const count = result.results.length;

		return ` (${count} result${count === 1 ? '' : 's'})`;
	}

	return '';
}

export function toolItemSummary(
	toolLog: AssistantTimelineTool,
	sessionCommands: ReadonlyMap<string, string>
) {
	const kind = toolLog.job?.kind ?? toolLog.name;

	if (isSessionCommandToolKind(kind)) {
		return (
			resolveCommandSessionLabel(toolLog, sessionCommands) ??
			summarizeTool(kind, toolLog.job?.payload ?? toolLog.input)
		);
	}

	if (kind === 'list_artifacts') {
		return summarizeArtifactListResult(toolLog.job?.result ?? toolLog.output);
	}

	if (
		kind === 'add_artifact' ||
		kind === 'edit_artifact' ||
		kind === 'save_artifact' ||
		kind === 'delete_artifact' ||
		kind === 'create_artifact'
	) {
		return summarizeArtifactTool(
			toolLog.job?.payload ?? toolLog.input,
			toolLog.job?.result ?? toolLog.output
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

	const error = assistantTimelineToolError(toolLog, isStreaming);

	return error ? `${summary} (${error})` : summary;
}
