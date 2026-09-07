import { v, type Infer } from 'convex/values';
import { isJsonObject, type JsonValue } from '@convex/lib/json';
import { MAX_IMAGE_ATTACHMENTS, vReasoningEffort, vServiceTier } from '@convex/lib/validators';

export const MACHINE_REQUEST_TTL_MS = 60_000;
export const MACHINE_REQUEST_CLAIM_TTL_MS = 90_000;
export const MACHINE_REQUEST_TERMINAL_RETENTION_MS = 5 * 60_000;
export const MAX_MACHINE_REQUESTS_IN_FLIGHT = 8;
export const MAX_MACHINE_REQUEST_ID_LENGTH = 128;
export const MAX_MACHINE_REQUEST_PROMPT_CHARS = 100_000;
export const MAX_MACHINE_REQUEST_PATH_CHARS = 4_096;
export const MAX_MACHINE_REQUEST_MODEL_CHARS = 256;
export const MAX_MACHINE_REQUEST_RESULT_BYTES = 64 * 1024;
export const MAX_MACHINE_REQUEST_ERROR_CHARS = 2_000;
export const MACHINE_REQUEST_FAIL_PAGE_SIZE = 16;

export const MACHINE_REQUEST_STOPPED = 'The machine stopped before this request finished.';
export const MACHINE_REQUEST_EXPIRED = 'This hosted command expired before the machine claimed it.';
export const MACHINE_REQUEST_CLAIM_EXPIRED =
	'The machine claimed this hosted command but did not finish it.';
export const MACHINE_REQUEST_NOT_CAPABLE = 'This machine cannot accept hosted commands.';

export const vMachineRequestStatus = v.union(
	v.literal('pending'),
	v.literal('claimed'),
	v.literal('completed'),
	v.literal('failed')
);

export const vMachineCommand = v.union(
	v.object({
		kind: v.literal('runAgent'),
		submissionId: v.string(),
		threadId: v.optional(v.id('threadRecords')),
		repositoryKey: v.optional(v.string()),
		continuationOfRunId: v.optional(v.id('runs')),
		prompt: v.string(),
		imageUploadIds: v.array(v.id('imageUploads')),
		selectedModel: v.string(),
		reasoningEffort: vReasoningEffort,
		serviceTier: vServiceTier,
		workspacePath: v.string()
	}),
	v.object({
		kind: v.literal('listProjects')
	}),
	v.object({
		kind: v.literal('attachProject'),
		workspacePath: v.string(),
		replaceWorkspacePath: v.optional(v.string())
	}),
	v.object({
		kind: v.literal('resolveWorkspacePath'),
		workspacePath: v.string(),
		createIfMissing: v.optional(v.boolean())
	}),
	v.object({
		kind: v.literal('browseFilesystem'),
		partialPath: v.string(),
		cwd: v.optional(v.string())
	}),
	v.object({
		kind: v.literal('listWorkspaceSkills'),
		workspacePath: v.string()
	})
);

export const vMachineRequestSnapshot = v.object({
	_id: v.id('machineRequests'),
	command: vMachineCommand,
	userId: v.string(),
	expiresAt: v.number()
});

export const vMachineRequestGetResult = v.object({
	status: vMachineRequestStatus,
	result: v.optional(v.string()),
	error: v.optional(v.string())
});

export type MachineCommand = Infer<typeof vMachineCommand>;
export type MachineRequestStatus = Infer<typeof vMachineRequestStatus>;
export type MachineRequestSnapshot = Infer<typeof vMachineRequestSnapshot>;
export type MachineRequestGetResult = Infer<typeof vMachineRequestGetResult>;

export function requireRequestId(requestId: string): string {
	const trimmed = requestId.trim();
	if (!trimmed) throw new Error('Request ID cannot be empty.');
	if (trimmed.length > MAX_MACHINE_REQUEST_ID_LENGTH) {
		throw new Error(`Request ID cannot exceed ${MAX_MACHINE_REQUEST_ID_LENGTH} characters.`);
	}
	return trimmed;
}

export function validateMachineCommand(command: MachineCommand): void {
	switch (command.kind) {
		case 'runAgent':
			requireBoundedText('submission ID', command.submissionId, MAX_MACHINE_REQUEST_ID_LENGTH);
			requireBoundedText('model', command.selectedModel, MAX_MACHINE_REQUEST_MODEL_CHARS);
			requireBoundedText('workspace path', command.workspacePath, MAX_MACHINE_REQUEST_PATH_CHARS);
			if (command.prompt.length > MAX_MACHINE_REQUEST_PROMPT_CHARS) {
				throw new Error(`Prompt cannot exceed ${MAX_MACHINE_REQUEST_PROMPT_CHARS} characters.`);
			}
			if (command.repositoryKey !== undefined) {
				requireBoundedText('repository key', command.repositoryKey, MAX_MACHINE_REQUEST_ID_LENGTH);
			}
			if (command.imageUploadIds.length > MAX_IMAGE_ATTACHMENTS) {
				throw new Error(`Attach at most ${MAX_IMAGE_ATTACHMENTS} images.`);
			}
			return;
		case 'listProjects':
			return;
		case 'attachProject':
			requireBoundedText('workspace path', command.workspacePath, MAX_MACHINE_REQUEST_PATH_CHARS);
			if (command.replaceWorkspacePath !== undefined) {
				requireBoundedText(
					'replace workspace path',
					command.replaceWorkspacePath,
					MAX_MACHINE_REQUEST_PATH_CHARS
				);
			}
			return;
		case 'resolveWorkspacePath':
			requireBoundedText('workspace path', command.workspacePath, MAX_MACHINE_REQUEST_PATH_CHARS);
			return;
		case 'browseFilesystem':
			if (command.partialPath.length > MAX_MACHINE_REQUEST_PATH_CHARS) {
				throw new Error(`Path cannot exceed ${MAX_MACHINE_REQUEST_PATH_CHARS} characters.`);
			}
			if (command.cwd !== undefined && command.cwd.length > MAX_MACHINE_REQUEST_PATH_CHARS) {
				throw new Error(`Path cannot exceed ${MAX_MACHINE_REQUEST_PATH_CHARS} characters.`);
			}
			return;
		case 'listWorkspaceSkills':
			requireBoundedText('workspace path', command.workspacePath, MAX_MACHINE_REQUEST_PATH_CHARS);
			return;
		default: {
			const exhaustive: never = command;
			throw new Error(`Unsupported machine command: ${JSON.stringify(exhaustive)}`);
		}
	}
}

export function commandsMatch(left: MachineCommand, right: MachineCommand): boolean {
	return stableJson(left) === stableJson(right);
}

export function requireExclusiveCompletion(args: {
	result?: string;
	error?: string;
}): { result: string; error?: undefined } | { result?: undefined; error: string } {
	if (args.error !== undefined && args.result !== undefined) {
		throw new Error('Machine request completion requires exactly one of result or error.');
	}
	if (args.error !== undefined) return { error: args.error };
	if (args.result !== undefined) return { result: args.result };
	throw new Error('Machine request completion requires exactly one of result or error.');
}

export function requireResultBound(result: string | undefined): void {
	if (result === undefined) return;
	if (new TextEncoder().encode(result).length > MAX_MACHINE_REQUEST_RESULT_BYTES) {
		throw new Error(`Machine response cannot exceed ${MAX_MACHINE_REQUEST_RESULT_BYTES} bytes.`);
	}
}

export function requireErrorBound(error: string | undefined): void {
	if (error === undefined) return;
	if (error.length > MAX_MACHINE_REQUEST_ERROR_CHARS) {
		throw new Error(`Machine error cannot exceed ${MAX_MACHINE_REQUEST_ERROR_CHARS} characters.`);
	}
}

export function sameCompletion(
	request: { status: MachineRequestStatus; result?: string; error?: string },
	args: { result?: string; error?: string }
): boolean {
	if (args.error !== undefined) {
		return (
			request.status === 'failed' && request.error === args.error && request.result === undefined
		);
	}
	return (
		request.status === 'completed' && request.result === args.result && request.error === undefined
	);
}

function requireBoundedText(label: string, value: string, maxChars: number): void {
	if (!value.trim()) throw new Error(`${capitalize(label)} cannot be empty.`);
	if (value.length > maxChars) {
		throw new Error(`${capitalize(label)} cannot exceed ${maxChars} characters.`);
	}
}

function capitalize(value: string): string {
	return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function stableJson(value: JsonValue): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(',')}]`;
	}
	if (!isJsonObject(value)) return JSON.stringify(value);
	const entries = Object.entries(value)
		.filter(([, nested]) => nested !== undefined)
		.sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`;
}
