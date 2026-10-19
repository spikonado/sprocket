import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

type Props = {
	title: string;
	description: string;
	confirmLabel: string;
	destructive?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
};

export default function ConfirmDialog({
	title,
	description,
	confirmLabel,
	destructive = false,
	onCancel,
	onConfirm
}: Props) {
	const id = useId();
	const dialogRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const previouslyFocused = document.activeElement;
		dialogRef.current?.showModal();

		return () => {
			if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
				previouslyFocused.focus();
			}
		};
	}, []);

	return createPortal(
		<dialog
			ref={dialogRef}
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-description`}
			className="bg-background text-foreground fixed inset-0 m-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl border p-6 shadow-xl backdrop:bg-black/40"
			onCancel={onCancel}
		>
			<h2 id={`${id}-title`} className="text-lg font-medium">
				{title}
			</h2>
			<p id={`${id}-description`} className="text-muted-foreground mt-3 text-sm">
				{description}
			</p>
			<div className="mt-6 flex justify-end gap-2">
				<button
					type="button"
					className="hover:bg-hover-fill rounded-lg px-4 py-2 text-sm"
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					type="button"
					className={`rounded-lg px-4 py-2 text-sm ${
						destructive
							? 'bg-destructive text-destructive-foreground'
							: 'bg-foreground text-background'
					}`}
					onClick={onConfirm}
				>
					{confirmLabel}
				</button>
			</div>
		</dialog>,
		document.body
	);
}
