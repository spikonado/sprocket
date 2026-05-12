import type { Infer } from 'convex/values';
import { isRunFinalStatus, vRunStatus } from '@convex/lib/validators';

export function assertThreadCanStartRun(status: Infer<typeof vRunStatus> | null | undefined) {
	if (!status || isRunFinalStatus(status)) {
		return;
	}

	throw new Error('Finish or cancel the active run before sending another message.');
}
