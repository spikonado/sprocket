import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function RestartConfirmation({
	onCancel,
	onConfirm
}: {
	onCancel: () => void;
	onConfirm: () => void;
}) {
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
			aria-labelledby="restart-confirmation-title"
			aria-describedby="restart-confirmation-description"
			className="bg-background text-foreground fixed inset-0 m-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl border p-6 shadow-xl backdrop:bg-black/40"
			onCancel={onCancel}
		>
			<h2 id="restart-confirmation-title" className="text-lg font-medium">
				Restart Sprocket?
			</h2>
			<p id="restart-confirmation-description" className="text-muted-foreground mt-3 text-sm">
				Automatic continuation is off. Restarting will interrupt active agents, and they won't
				resume automatically.
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
					className="bg-foreground text-background rounded-lg px-4 py-2 text-sm"
					onClick={onConfirm}
				>
					Restart Sprocket
				</button>
			</div>
		</dialog>,
		document.body
	);
}
