import type { Doc } from '@convex/_generated/dataModel';
import { isRunFinalStatus } from '@convex/lib/validators';

export function shouldIncludeMessageInCanonicalAgentHistory(args: {
	role: Doc<'threadMessages'>['role'];
	messageStatus: Doc<'threadMessages'>['status'];
	runStatus: Doc<'runs'>['status'] | null;
}) {
	if (args.role === 'user') {
		return args.messageStatus === 'success' || args.messageStatus === 'failed';
	}

	if (args.messageStatus === 'success' || args.messageStatus === 'failed') {
		return true;
	}

	// Cancellation can finalize the run before the assistant message record leaves `streaming`.
	// Keep that partial turn in history so follow-up runs can still see prior tool work.
	return args.messageStatus === 'streaming' && !!args.runStatus && isRunFinalStatus(args.runStatus);
}
