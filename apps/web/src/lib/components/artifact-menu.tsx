import { Ellipsis, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Props = {
	title: string;
	onDelete?: () => Promise<void>;
} & ({ trigger: 'context'; children: ReactNode } | { trigger: 'button'; children?: never });

export default function ArtifactMenu({ title, onDelete, trigger, children }: Props) {
	const menuId = useId();
	const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const busyRef = useRef(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	const close = useCallback(() => {
		const hadFocus = menuRef.current?.contains(document.activeElement);
		setPosition(null);

		if (hadFocus && triggerRef.current?.isConnected) {
			triggerRef.current.focus({ preventScroll: true });
		}
	}, []);

	useEffect(() => {
		if (!position) return;
		const button = menuRef.current?.querySelector('button');

		if (button && !button.disabled) button.focus();
		else menuRef.current?.focus();
	}, [position, busy]);

	useEffect(() => {
		if (!position) return;

		function outside(event: MouseEvent) {
			if (!(event.target instanceof Node)) return;

			if (menuRef.current?.contains(event.target)) return;

			if (trigger === 'button' && triggerRef.current?.contains(event.target)) return;
			close();
		}

		function keydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopImmediatePropagation();
				close();
			} else if (event.key === 'Tab') {
				close();
			}
		}

		function blur() {
			// Entering a preview iframe blurs the parent window. Do not restore focus
			// to the trigger while the user is interacting with that preview.
			setPosition(null);
		}

		document.addEventListener('mousedown', outside);
		window.addEventListener('blur', blur);
		window.addEventListener('keydown', keydown, true);
		window.addEventListener('resize', close);
		window.addEventListener('scroll', close, true);

		return () => {
			document.removeEventListener('mousedown', outside);
			window.removeEventListener('blur', blur);
			window.removeEventListener('keydown', keydown, true);
			window.removeEventListener('resize', close);
			window.removeEventListener('scroll', close, true);
		};
	}, [position, close, trigger]);

	function open(button: HTMLButtonElement, x: number, y: number) {
		triggerRef.current = button;
		setPosition({
			x: Math.max(8, Math.min(x, window.innerWidth - 240)),
			y: Math.max(8, Math.min(y, window.innerHeight - 140))
		});
	}

	function openButton(button: HTMLButtonElement) {
		const bounds = button.getBoundingClientRect();
		open(button, bounds.right - 224, bounds.bottom + 4);
	}

	async function remove() {
		if (!onDelete || busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError(null);
		// Keep focus inside the menu while its action is disabled during deletion.
		menuRef.current?.focus({ preventScroll: true });

		try {
			await onDelete();
			close();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : 'Unable to delete artifact.');
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	return (
		<div
			className="contents"
			onContextMenu={(event) => {
				if (!onDelete || trigger !== 'context') return;
				const button = event.currentTarget.querySelector('button');

				if (!button) return;

				event.preventDefault();
				event.stopPropagation();
				open(button, event.clientX, event.clientY);
			}}
			onKeyDown={(event) => {
				if (
					!onDelete ||
					trigger !== 'context' ||
					!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
				)
					return;
				const button = event.currentTarget.querySelector('button');

				if (!button) return;

				event.preventDefault();
				event.stopPropagation();
				const bounds = button.getBoundingClientRect();
				open(button, bounds.left, bounds.bottom);
			}}
		>
			{trigger === 'context' ? (
				children
			) : (
				<button
					type="button"
					aria-label={`${title} actions`}
					title="Artifact actions"
					aria-haspopup="menu"
					aria-expanded={Boolean(position)}
					aria-controls={position ? menuId : undefined}
					className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring shrink-0 rounded-md p-1.5 transition outline-none focus-visible:ring-2"
					onClick={(event) => {
						if (position) {
							close();

							return;
						}

						openButton(event.currentTarget);
					}}
					onKeyDown={(event) => {
						if (event.key !== 'ArrowDown') return;
						event.preventDefault();
						openButton(event.currentTarget);
					}}
				>
					<Ellipsis className="size-4" aria-hidden="true" />
				</button>
			)}
			{error &&
				!position &&
				createPortal(
					<div
						role="alert"
						className="bg-popover text-popover-foreground fixed right-4 bottom-4 z-250 w-80 max-w-[calc(100vw-2rem)] rounded-md border p-3 shadow-md"
					>
						<div className="flex items-center justify-between gap-2">
							<p className="text-destructive text-sm font-medium">Artifact deletion failed</p>
							<button
								type="button"
								aria-label="Dismiss deletion error"
								className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm p-1 outline-none focus-visible:ring-2"
								onClick={() => {
									setError(null);
									triggerRef.current?.focus({ preventScroll: true });
								}}
							>
								<X className="size-3.5" aria-hidden="true" />
							</button>
						</div>
						<p className="mt-1 text-sm wrap-break-word">
							{title}: {error}
						</p>
						<p className="text-muted-foreground mt-2 text-xs">
							Open the artifact menu to try again.
						</p>
					</div>,
					document.body
				)}
			{position &&
				createPortal(
					<div
						id={menuId}
						ref={menuRef}
						role="menu"
						tabIndex={-1}
						aria-label={`${title} actions`}
						className="bg-popover text-popover-foreground fixed z-250 w-56 rounded-md border p-1 shadow-md"
						style={{ left: position.x, top: position.y }}
					>
						<button
							type="button"
							role="menuitem"
							disabled={busy}
							className="text-destructive hover:bg-muted focus:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none disabled:opacity-50"
							onClick={() => void remove()}
						>
							<Trash2 className="size-4" aria-hidden="true" />
							{busy ? 'Deleting…' : 'Delete artifact'}
						</button>
						{error && (
							<p role="alert" className="px-2 py-1 text-xs">
								{error}
							</p>
						)}
					</div>,
					document.body
				)}
		</div>
	);
}
