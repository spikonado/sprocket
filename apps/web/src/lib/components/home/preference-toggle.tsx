import { useId, useState, type ReactNode } from 'react';
import { cn } from '$lib/utils';

export function SwitchTrack({ enabled }: { enabled: boolean }) {
	return (
		<span
			className={cn(
				'relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
				enabled ? 'bg-foreground' : 'bg-hover-fill-strong'
			)}
			aria-hidden="true"
		>
			<span
				className={cn(
					'bg-background inline-block size-3.5 rounded-full transition',
					enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
				)}
			/>
		</span>
	);
}

export default function PreferenceToggle({
	title,
	description,
	savedEnabled,
	disabled,
	save
}: {
	title: string;
	description?: ReactNode;
	savedEnabled: boolean;
	disabled: boolean;
	save: (args: { enabled: boolean }) => Promise<null>;
}) {
	const descriptionId = useId();
	const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const enabled = pendingEnabled ?? savedEnabled;
	const saving = pendingEnabled !== null;

	async function toggle() {
		if (disabled || saving) return;
		const nextEnabled = !enabled;
		setPendingEnabled(nextEnabled);
		setSaveError(null);

		try {
			await save({ enabled: nextEnabled });
		} catch {
			setSaveError("Couldn't save your preference. Try again.");
		} finally {
			setPendingEnabled(null);
		}
	}

	return (
		<div>
			<button
				type="button"
				role="switch"
				aria-checked={enabled}
				aria-label={title}
				aria-describedby={description ? descriptionId : undefined}
				disabled={disabled || saving}
				className="focus-visible:ring-ring/60 text-foreground hover:bg-hover-fill flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 disabled:cursor-wait disabled:opacity-50"
				onClick={() => void toggle()}
			>
				<span className="flex-1 font-medium">{title}</span>
				<SwitchTrack enabled={enabled} />
			</button>
			{description && (
				<p id={descriptionId} className="text-muted-foreground -mt-1 px-3 pr-15 text-[13px]">
					{description}
				</p>
			)}
			{saveError && (
				<p role="alert" className="text-destructive px-3 text-sm">
					{saveError}
				</p>
			)}
		</div>
	);
}
