import { useEffect, useId, useRef, useState } from 'react';
import Button from '$lib/components/ui/button/button';

export default function RemoveProjectDialog({
	project,
	onClose,
	onPrepareRemove,
	onRemove
}: {
	project: { workspacePath: string; displayName: string };
	onClose: () => void;
	onPrepareRemove?: (workspacePath: string, signal: AbortSignal) => Promise<void>;
	onRemove: (workspacePath: string) => Promise<void>;
}) {
	const titleId = useId();
	const descriptionId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const submittingRef = useRef(false);
	const removingRef = useRef(false);
	const preparationRef = useRef<AbortController | null>(null);
	const onCloseRef = useRef(onClose);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isRemoving, setIsRemoving] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;

		dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();

		function handleKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();

				if (!removingRef.current) {
					preparationRef.current?.abort();
					onCloseRef.current();
				}

				return;
			}

			const dialog = dialogRef.current;

			if (event.key !== 'Tab' || !dialog) return;

			const buttons = dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
			const first = buttons[0];
			const last = buttons[buttons.length - 1];
			const active = document.activeElement;

			if (!first || !last) {
				event.preventDefault();
				dialog.focus();
			} else if (
				event.shiftKey &&
				(active === first || active === dialog || !dialog.contains(active))
			) {
				event.preventDefault();
				last.focus();
			} else if (
				!event.shiftKey &&
				(active === last || active === dialog || !dialog.contains(active))
			) {
				event.preventDefault();
				first.focus();
			}
		}

		window.addEventListener('keydown', handleKeydown, true);

		return () => {
			preparationRef.current?.abort();
			window.removeEventListener('keydown', handleKeydown, true);

			if (previouslyFocused?.isConnected) previouslyFocused.focus();
		};
	}, []);

	function close() {
		if (removingRef.current) return;
		preparationRef.current?.abort();
		onClose();
	}

	async function removeProject() {
		if (submittingRef.current) return;

		submittingRef.current = true;
		setIsSubmitting(true);
		setErrorMessage(null);
		dialogRef.current?.focus();
		const preparation = new AbortController();
		preparationRef.current = preparation;

		try {
			if (onPrepareRemove) await onPrepareRemove(project.workspacePath, preparation.signal);

			if (preparation.signal.aborted) return;
			removingRef.current = true;
			setIsRemoving(true);
			await onRemove(project.workspacePath);
		} catch (error) {
			if (preparation.signal.aborted) return;
			setErrorMessage(
				error instanceof Error && error.message
					? error.message
					: 'Failed to remove project. Please try again.'
			);
			submittingRef.current = false;
			removingRef.current = false;
			setIsSubmitting(false);
			setIsRemoving(false);

			return;
		}

		onClose();
	}

	return (
		<div
			className="bg-overlay fixed inset-0 z-[250] flex items-center justify-center px-4 backdrop-blur-[2px]"
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div
				ref={dialogRef}
				className="border-border bg-popover text-foreground max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-[1.4rem] border p-6 shadow-2xl outline-none"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={descriptionId}
				aria-busy={isSubmitting}
				tabIndex={-1}
			>
				<h2 id={titleId} className="text-lg font-semibold">
					Remove project?
				</h2>
				<div
					id={descriptionId}
					className="text-muted-foreground mt-3 space-y-3 text-sm leading-relaxed"
				>
					<p>
						Remove <strong className="text-foreground">{project.displayName}</strong> from this
						computer’s project list?
					</p>
					<code className="border-border bg-hover-fill text-foreground block rounded-lg border px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap select-all">
						{project.workspacePath}
					</code>
					<p>Your files, threads, and artifacts will be retained. Running agents will continue.</p>
					<p>
						Pending file uploads for this project will finish before removal. You can cancel while
						waiting.
					</p>
					<p>Re-add this folder to restore its history.</p>
				</div>
				{errorMessage && (
					<p className="text-destructive mt-4 text-sm" role="alert">
						{errorMessage}
					</p>
				)}
				<div className="mt-6 flex flex-wrap justify-end gap-3">
					<Button variant="outline" disabled={isRemoving} onclick={close}>
						Cancel
					</Button>
					<Button disabled={isSubmitting} onclick={() => void removeProject()}>
						{isRemoving ? 'Removing…' : isSubmitting ? 'Waiting for uploads…' : 'Remove project'}
					</Button>
				</div>
			</div>
		</div>
	);
}
