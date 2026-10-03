import { Ellipsis, Trash2 } from 'lucide-react';
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
	const triggerRef = useRef<HTMLElement | null>(null);

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

	function open(target: EventTarget, container: HTMLElement, x: number, y: number) {
		if (!(target instanceof Element)) return;
		const focusable = 'button, a[href], [tabindex]';
		const control = target.closest<HTMLElement>(focusable);
		triggerRef.current =
			(control && container.contains(control) ? control : null) ??
			container.querySelector<HTMLElement>(focusable) ??
			(target instanceof HTMLElement ? target : null);
		setError(null);
		setPosition({
			x: Math.max(8, Math.min(x, window.innerWidth - 240)),
			y: Math.max(8, Math.min(y, window.innerHeight - 140))
		});
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
				event.preventDefault();
				event.stopPropagation();
				open(event.target, event.currentTarget, event.clientX, event.clientY);
			}}
			onKeyDown={(event) => {
				if (
					!onDelete ||
					trigger !== 'context' ||
					!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
				)
					return;
				event.preventDefault();
				event.stopPropagation();

				const bounds =
					event.target instanceof Element ? event.target.getBoundingClientRect() : null;

				if (bounds) open(event.target, event.currentTarget, bounds.left, bounds.bottom);
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

						const bounds = event.currentTarget.getBoundingClientRect();
						open(event.currentTarget, event.currentTarget, bounds.right - 224, bounds.bottom + 4);
					}}
					onKeyDown={(event) => {
						if (event.key !== 'ArrowDown') return;
						event.preventDefault();
						const bounds = event.currentTarget.getBoundingClientRect();
						open(event.currentTarget, event.currentTarget, bounds.right - 224, bounds.bottom + 4);
					}}
				>
					<Ellipsis className="size-4" aria-hidden="true" />
				</button>
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
