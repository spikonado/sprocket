import type { Doc } from '@convex/_generated/dataModel';

type RunStatus = Doc<'runs'>['status'];

export function isActiveRunStatus(status: RunStatus) {
	return status === 'queued' || status === 'running' || status === 'awaiting_executor';
}
