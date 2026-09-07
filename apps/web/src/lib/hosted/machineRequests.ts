import { v } from 'convex/values';
import {
	MACHINE_REQUEST_CLAIM_TTL_MS,
	MACHINE_REQUEST_TTL_MS,
	type MachineCommand
} from '$convex/lib/machineRequests';
import { reasoningEffortIds, serviceTierIds } from '$convex/lib/models';
import type { AgentRunRequest } from '$lib/types/sprocket';

export const MACHINE_REQUEST_WAIT_MS = MACHINE_REQUEST_TTL_MS + MACHINE_REQUEST_CLAIM_TTL_MS;
export const MACHINE_REQUEST_DISCONNECT_MS = 15_000;
export const MACHINE_REQUEST_TIMEOUT =
	'This hosted command timed out. An agent may have started on the original machine.';

export const vProjectAttachment = v.object({
	workspacePath: v.string(),
	repositoryKey: v.string(),
	displayName: v.string(),
	availability: v.union(v.literal('available'), v.literal('unavailable')),
	lastValidatedAt: v.number(),
	lastUsedAt: v.number(),
	unavailableReason: v.optional(v.string()),
	previousRepositoryKey: v.optional(v.string())
});

export const vFilesystemBrowseResult = v.object({
	parentPath: v.string(),
	entries: v.array(v.object({ name: v.string(), fullPath: v.string() })),
	volumeList: v.optional(v.boolean())
});

export const vWorkspaceSkillsResult = v.object({
	skills: v.array(v.object({ name: v.string(), description: v.string() })),
	warnings: v.array(v.string())
});

export const vWorkspacePathResolution = v.object({
	workspacePath: v.string(),
	displayName: v.string(),
	repositoryKey: v.string()
});

export const vAgentRunStart = v.object({
	runId: v.id('runs'),
	threadId: v.id('threadRecords')
});

export const vProjectAttachmentList = v.array(vProjectAttachment);

export type RunAgentCommand = Extract<MachineCommand, { kind: 'runAgent' }>;
export type { MachineCommand };

function reasoningEffort(value: string): RunAgentCommand['reasoningEffort'] {
	for (const effort of reasoningEffortIds) {
		if (effort === value) return effort;
	}
	throw new Error(`Unsupported reasoning effort: ${value}`);
}

function serviceTier(value: string): RunAgentCommand['serviceTier'] {
	for (const tier of serviceTierIds) {
		if (tier === value) return tier;
	}
	throw new Error(`Unsupported service tier: ${value}`);
}

export function runAgentCommand(request: Omit<AgentRunRequest, 'userId'>): RunAgentCommand {
	const command: RunAgentCommand = {
		kind: 'runAgent',
		submissionId: request.submissionId,
		prompt: request.prompt,
		imageUploadIds: request.imageUploadIds,
		selectedModel: request.selectedModel,
		reasoningEffort: reasoningEffort(request.reasoningEffort),
		serviceTier: serviceTier(request.serviceTier),
		workspacePath: request.workspacePath
	};
	if (request.threadId) command.threadId = request.threadId;
	if (request.repositoryKey) command.repositoryKey = request.repositoryKey;
	if (request.continuationOfRunId) command.continuationOfRunId = request.continuationOfRunId;
	return command;
}

export function machineRequestIdForRun(submissionId: string): string {
	return submissionId;
}
