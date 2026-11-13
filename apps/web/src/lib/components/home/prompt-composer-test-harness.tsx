import { useState } from 'react';
import PromptComposer, { type PromptComposerProps } from './prompt-composer';

export default function PromptComposerTestHarness({
	composerProps
}: {
	composerProps: PromptComposerProps;
}) {
	const [prompt, setPrompt] = useState(composerProps.prompt ?? '');
	const [selectedModel, setSelectedModel] = useState(composerProps.selectedModel);

	const [selectedReasoningEffort, setSelectedReasoningEffort] = useState(
		composerProps.selectedReasoningEffort
	);

	const [serviceTier, setServiceTier] = useState(composerProps.serviceTier);

	const [selectedQuestionOptionId, setSelectedQuestionOptionId] = useState(
		composerProps.selectedQuestionOptionId
	);

	return (
		<PromptComposer
			{...composerProps}
			prompt={prompt}
			onPromptChange={(next) => {
				setPrompt(next);
				composerProps.onPromptChange?.(next);
			}}
			selectedModel={selectedModel}
			onSelectedModelChange={(next) => {
				setSelectedModel(next);
				composerProps.onSelectedModelChange?.(next);
			}}
			selectedReasoningEffort={selectedReasoningEffort}
			onSelectedReasoningEffortChange={(next) => {
				setSelectedReasoningEffort(next);
				composerProps.onSelectedReasoningEffortChange?.(next);
			}}
			serviceTier={serviceTier}
			onServiceTierChange={(next) => {
				setServiceTier(next);
				composerProps.onServiceTierChange?.(next);
			}}
			selectedQuestionOptionId={selectedQuestionOptionId}
			onSelectedQuestionOptionIdChange={(next) => {
				setSelectedQuestionOptionId(next);
				composerProps.onSelectedQuestionOptionIdChange?.(next);
			}}
		/>
	);
}
