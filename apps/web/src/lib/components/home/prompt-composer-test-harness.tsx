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

	const [fastMode, setFastMode] = useState(composerProps.fastMode);

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
			fastMode={fastMode}
			onFastModeChange={(next) => {
				setFastMode(next);
				composerProps.onFastModeChange?.(next);
			}}
			selectedQuestionOptionId={selectedQuestionOptionId}
			onSelectedQuestionOptionIdChange={(next) => {
				setSelectedQuestionOptionId(next);
				composerProps.onSelectedQuestionOptionIdChange?.(next);
			}}
		/>
	);
}
