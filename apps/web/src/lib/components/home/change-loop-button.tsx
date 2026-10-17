import { useState } from 'react';
import OptionSelector from '$lib/components/option-selector';
import { changeLoopOptions, type ChangeLoopMode } from '$lib/home/change-loops';

export default function ChangeLoopButton({
	disabled,
	onRun
}: {
	disabled: boolean;
	onRun?: (mode: ChangeLoopMode) => void;
}) {
	const [mode, setMode] = useState<ChangeLoopMode>('cleanup-and-review');
	const selectedOption = changeLoopOptions.find((option) => option.id === mode);

	return (
		<div className="border-border bg-surface/80 text-foreground inline-flex max-w-full items-stretch rounded-full border text-[13px] font-medium">
			<button
				type="button"
				className="hover:bg-hover-fill focus-visible:ring-ring/60 min-w-0 rounded-l-full px-3 py-1.5 text-left transition outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
				disabled={disabled}
				onClick={() => {
					setMode('cleanup-and-review');
					onRun?.(mode);
				}}
			>
				{selectedOption?.label}
			</button>
			<OptionSelector
				value={mode}
				options={changeLoopOptions}
				ariaLabel="Select change loop"
				menuTitle="Change loop"
				compactOnMobile
				disabled={disabled}
				onValueChange={setMode}
				className="border-border shrink-0 border-l"
				triggerClassName="h-full gap-0 rounded-l-none rounded-r-full border-0 px-2 text-foreground"
			/>
		</div>
	);
}
