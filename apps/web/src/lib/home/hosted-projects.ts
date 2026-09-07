import {
	findProjectByRepositoryKey,
	getProjectThreadGroups,
	isActiveThread
} from '$lib/project/threads';
import type { ProjectThreadGroup, ThreadSummary } from '$lib/types/sprocket';
import type { ProjectState } from '$lib/home/desktop';
import { hostedOpIsCurrent, type HostedOp } from '$lib/home/hosted-machines';

export const HOSTED_VIRTUAL_WORKSPACE_PREFIX = 'cloud:';

export function virtualWorkspacePath(repositoryKey: string): string {
	return `${HOSTED_VIRTUAL_WORKSPACE_PREFIX}${encodeURIComponent(repositoryKey)}`;
}

export function isHostedVirtualWorkspacePath(workspacePath: string | null | undefined): boolean {
	return Boolean(workspacePath?.startsWith(HOSTED_VIRTUAL_WORKSPACE_PREFIX));
}

export function hostedVirtualProjectError(hasReadyMachine: boolean): string {
	return hasReadyMachine
		? 'Attach a folder on this machine to run this project.'
		: 'Choose a running machine, then attach a folder to run this project.';
}

export function virtualProjectFromRepositoryKey(
	repositoryKey: string,
	attachmentError: string
): ProjectState {
	return {
		repositoryKey,
		displayName: repositoryKey || 'Unassigned threads',
		workspacePath: virtualWorkspacePath(repositoryKey),
		localAttachmentAvailability: 'unavailable',
		localAttachmentError: attachmentError
	};
}

export function mergeHostedBrowsableProjects(args: {
	attachedProjects: ProjectState[];
	threads: ThreadSummary[];
	hasReadyMachine: boolean;
}): ProjectState[] {
	const attachedKeys = new Set(
		args.attachedProjects.map((project) => project.repositoryKey).filter(Boolean)
	);
	const virtual: ProjectState[] = [];
	const seen = new Set<string>();
	const attachmentError = hostedVirtualProjectError(args.hasReadyMachine);

	for (const thread of args.threads) {
		if (!isActiveThread(thread)) {
			continue;
		}
		if (attachedKeys.has(thread.repositoryKey) || seen.has(thread.repositoryKey)) {
			continue;
		}
		seen.add(thread.repositoryKey);
		virtual.push(virtualProjectFromRepositoryKey(thread.repositoryKey, attachmentError));
	}

	return [...args.attachedProjects, ...virtual];
}

export function getHostedProjectThreadGroups(args: {
	attachedProjects: ProjectState[];
	threads: ThreadSummary[];
	hasReadyMachine: boolean;
}): ProjectThreadGroup[] {
	return getProjectThreadGroups(mergeHostedBrowsableProjects(args), args.threads);
}

export function hostedExecutionProject(args: {
	repositoryKey: string | null | undefined;
	attachedProjects: ProjectState[];
}): ProjectState | null {
	if (!args.repositoryKey) {
		return null;
	}
	return (
		args.attachedProjects.find(
			(project) =>
				project.repositoryKey === args.repositoryKey &&
				project.localAttachmentAvailability === 'available'
		) ?? null
	);
}

export function shouldVerifyHostedWorkspace(project: ProjectState | null): boolean {
	return (
		project?.localAttachmentAvailability === 'available' &&
		!isHostedVirtualWorkspacePath(project.workspacePath)
	);
}

export function workspaceAfterHostedMachineChange(args: {
	currentThreadId: string | null;
	currentRepositoryKey: string | null;
}) {
	if (args.currentThreadId && args.currentRepositoryKey !== null) {
		return {
			workspacePath: virtualWorkspacePath(args.currentRepositoryKey),
			keepThread: true
		};
	}
	return { workspacePath: null, keepThread: false };
}

export function hostedLaunchWorkspaceIsSafe(args: {
	op: HostedOp;
	currentEpoch: number;
	machineId: string | null;
	workspacePath: string;
	attachedProjects: Array<Pick<ProjectState, 'workspacePath' | 'localAttachmentAvailability'>>;
}): boolean {
	if (!hostedOpIsCurrent(args.op, args.currentEpoch)) {
		return false;
	}
	if (!args.machineId || isHostedVirtualWorkspacePath(args.workspacePath)) {
		return false;
	}
	return args.attachedProjects.some(
		(project) =>
			project.workspacePath === args.workspacePath &&
			project.localAttachmentAvailability === 'available'
	);
}

export function hostedInitialSelectionReady(args: {
	threadSnapshotReady: boolean;
	selectedMachineId: string | null;
	attachmentsReady: boolean;
}): boolean {
	if (!args.threadSnapshotReady) {
		return false;
	}
	return args.selectedMachineId === null || args.attachmentsReady;
}

export function hostedThreadWorkspacePath(args: {
	threadRepositoryKey: string | null | undefined;
	currentWorkspacePath: string | null;
	attachedProjects: ProjectState[];
	browsableProjects: ProjectState[];
}): string | null {
	const executable = hostedExecutionProject({
		repositoryKey: args.threadRepositoryKey,
		attachedProjects: args.attachedProjects
	});
	if (executable) {
		return executable.workspacePath;
	}
	if (
		args.currentWorkspacePath &&
		isHostedVirtualWorkspacePath(args.currentWorkspacePath) &&
		findProjectByRepositoryKey(args.browsableProjects, args.threadRepositoryKey)?.workspacePath ===
			args.currentWorkspacePath
	) {
		return args.currentWorkspacePath;
	}
	return (
		findProjectByRepositoryKey(args.browsableProjects, args.threadRepositoryKey)?.workspacePath ??
		null
	);
}
