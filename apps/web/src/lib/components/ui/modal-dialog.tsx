import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '$lib/utils';

export default function ModalDialog({
	title,
	description,
	className,
	onCancel,
	children
}: {
	title: string;
	description: string;
	className?: string;
	onCancel: () => void;
	children: ReactNode;
}) {
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
			className={cn(
				'bg-background text-foreground fixed inset-0 m-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl border p-6 shadow-xl backdrop:bg-black/40',
				className
			)}
			onCancel={onCancel}
		>
			<h2 id={`${id}-title`} className="text-lg">
				{title}
			</h2>
			<p id={`${id}-description`} className="text-muted-foreground mt-3 text-sm">
				{description}
			</p>
			{children}
		</dialog>,
		document.body
	);
}
