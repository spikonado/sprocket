import { useMemo, useState } from 'react';
import type { Id } from '@convex/_generated/dataModel';
import type { ComposerAttachment } from '$lib/chat/attachments';
import type { CatalogModelId } from '$lib/chat/model-catalog';

export type ComposerRecovery = {
	message: string | null;
	prompt: string;
	attachments?: ComposerAttachment[];
	storageIds?: Id<'_storage'>[];
	reasoningEffort?: string;
	fastMode?: boolean;
	selectedModel?: CatalogModelId;
	submissionId?: string;
	continuationOfRunId?: Id<'runs'>;
	autoSubmit?: boolean;
};

type RecoveredSubmission = {
	prompt: string;
	storageIds: Id<'_storage'>[];
	reasoningEffort: string;
	fastMode: boolean;
	selectedModel: CatalogModelId;
	submissionId: string;
	continuationOfRunId?: Id<'runs'>;
};

type LaunchedPrompt = {
	runId: Id<'runs'>;
	recovery: ComposerRecovery;
};

export function getComposerRecoveryKey(userId: string, scope: string) {
	return `${userId}\0${scope}`;
}

function resubmittable(recovery: ComposerRecovery): RecoveredSubmission | null {
	const { submissionId, reasoningEffort, selectedModel } = recovery;

	if (!submissionId || !reasoningEffort || !selectedModel) return null;

	if (!recovery.prompt && !recovery.storageIds?.length) return null;

	return {
		prompt: recovery.prompt,
		storageIds: recovery.storageIds ?? [],
		reasoningEffort,
		fastMode: recovery.fastMode ?? false,
		selectedModel,
		submissionId,
		continuationOfRunId: recovery.continuationOfRunId
	};
}

export function useSubmissionTracker() {
	const [version, setVersion] = useState(0);

	const [state] = useState(() => ({
		submittingSequences: new Map<string, number>(),
		recoveries: new Map<string, ComposerRecovery>(),
		recoveredSubmissions: new Map<string, RecoveredSubmission>(),
		launchedPrompts: new Map<string, LaunchedPrompt>()
	}));

	return useMemo(() => {
		const changed = () => setVersion((current) => current + 1);

		return {
			version,
			isSubmitting: (scope: string) => state.submittingSequences.has(scope),
			startSubmitting(scope: string, submissionSequence: number) {
				state.submittingSequences.set(scope, submissionSequence);
				changed();
			},
			finishSubmitting(scope: string, submissionSequence: number) {
				if (state.submittingSequences.get(scope) !== submissionSequence) return;
				state.submittingSequences.delete(scope);
				changed();
			},
			storeRecovery(userId: string, scope: string, recovery: ComposerRecovery) {
				state.recoveries.set(getComposerRecoveryKey(userId, scope), recovery);
				changed();
			},
			clearRecovery(userId: string, scope: string) {
				const recoveryKey = getComposerRecoveryKey(userId, scope);
				state.recoveries.delete(recoveryKey);
				state.recoveredSubmissions.delete(recoveryKey);
				state.launchedPrompts.delete(recoveryKey);
				changed();
			},
			holdLaunchedPrompt(userId: string, scope: string, launched: LaunchedPrompt) {
				state.launchedPrompts.set(getComposerRecoveryKey(userId, scope), launched);
			},
			settleLaunchedPrompt(
				userId: string,
				scope: string,
				run: { runId: Id<'runs'>; promptUnsent?: true },
				ended: boolean
			) {
				const recoveryKey = getComposerRecoveryKey(userId, scope);
				const launched = state.launchedPrompts.get(recoveryKey);

				if (launched?.runId !== run.runId || (run.promptUnsent && !ended)) return;
				state.launchedPrompts.delete(recoveryKey);

				if (!run.promptUnsent) return;
				state.recoveries.set(recoveryKey, launched.recovery);
				changed();
			},
			recovery: (recoveryKey: string) => state.recoveries.get(recoveryKey),
			recoveredSubmission: (recoveryKey: string) => state.recoveredSubmissions.get(recoveryKey),
			restoreRecovery(recoveryKey: string, recovery: ComposerRecovery) {
				state.recoveries.delete(recoveryKey);
				const submission = resubmittable(recovery);

				if (submission) state.recoveredSubmissions.set(recoveryKey, submission);
				changed();
			}
		};
	}, [version, state]);
}
