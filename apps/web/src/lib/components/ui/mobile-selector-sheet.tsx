import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

export default function MobileSelectorSheet({
	title,
	onDismiss,
	children,
	footer,
	returnFocusRef
}: {
	title: string;
	onDismiss: () => void;
	children: ReactNode;
	footer?: ReactNode;
	returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
	const dialogRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		const returnFocus = returnFocusRef.current;

		dialog?.showModal();

		return () => {
			dialog?.close();
			returnFocus?.focus();
		};
	}, [returnFocusRef]);

	return (
		<dialog
			ref={dialogRef}
			aria-label={title}
			className="bg-popover text-foreground fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-hidden rounded-t-[28px] border border-[var(--hairline)] p-0 shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-sm"
			onCancel={(event) => {
				event.preventDefault();
				onDismiss();
			}}
			onClick={(event) => {
				if (event.target !== event.currentTarget) return;
				const rect = event.currentTarget.getBoundingClientRect();

				if (event.clientY < rect.top || event.clientY > rect.bottom) onDismiss();
			}}
		>
			<div className="flex max-h-[85dvh] flex-col pb-[max(1rem,env(safe-area-inset-bottom))]">
				<div
					className="bg-muted-foreground/25 mx-auto mt-3 h-1 w-9 shrink-0 rounded-full"
					aria-hidden="true"
				/>
				<header className="flex shrink-0 items-center justify-between px-5 py-2">
					<h2 className="text-lg font-semibold">{title}</h2>
					<button
						type="button"
						className="text-muted-foreground hover:bg-hover-fill focus-visible:ring-ring flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2"
						aria-label={`Close ${title.toLocaleLowerCase()}`}
						onClick={onDismiss}
					>
						<X className="size-5" />
					</button>
				</header>
				<div className="min-h-0 overflow-y-auto overscroll-contain px-4">{children}</div>
				{footer ? (
					<footer className="shrink-0 border-t border-[var(--hairline)] px-5 pt-4">{footer}</footer>
				) : null}
			</div>
		</dialog>
	);
}
