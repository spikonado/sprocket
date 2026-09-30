import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle } from 'lucide-react';
import Button from '$lib/components/ui/button/button';

export default function BrowserSignInOverlay({
	open,
	signInUrl,
	error = null,
	onCancel,
	onClearOpenError
}: {
	open: boolean;
	signInUrl: string | null;
	error?: string | null;
	onCancel: () => void;
	onClearOpenError?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const copiedTimeoutRef = useRef<number | null>(null);
	const onCancelRef = useRef(onCancel);
	const onClearOpenErrorRef = useRef(onClearOpenError);

	useEffect(() => {
		onCancelRef.current = onCancel;
		onClearOpenErrorRef.current = onClearOpenError;
	});

	useEffect(() => {
		if (!open) {
			setCopied(false);
			setCopyError(null);
			return;
		}

		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		dialogRef.current?.focus();

		function handleWindowKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				onCancelRef.current();
				return;
			}

			const dialogEl = dialogRef.current;
			if (event.key !== 'Tab' || !dialogEl) {
				return;
			}

			const focusable = Array.from(
				dialogEl.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			).filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);

			if (focusable.length === 0) {
				event.preventDefault();
				dialogEl.focus();
				return;
			}

			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			const active = document.activeElement;
			if (
				event.shiftKey &&
				(active === dialogEl || active === first || !dialogEl.contains(active))
			) {
				event.preventDefault();
				last.focus();
			} else if (
				!event.shiftKey &&
				(active === dialogEl || active === last || !dialogEl.contains(active))
			) {
				event.preventDefault();
				first.focus();
			}
		}

		window.addEventListener('keydown', handleWindowKeydown, true);
		return () => {
			window.removeEventListener('keydown', handleWindowKeydown, true);
			if (copiedTimeoutRef.current !== null) {
				window.clearTimeout(copiedTimeoutRef.current);
				copiedTimeoutRef.current = null;
			}
			if (previouslyFocused?.isConnected) {
				previouslyFocused.focus();
			}
		};
	}, [open]);

	async function copySignInUrl() {
		if (!signInUrl) {
			return;
		}

		try {
			await navigator.clipboard.writeText(signInUrl);
			setCopied(true);
			setCopyError(null);
			if (copiedTimeoutRef.current !== null) {
				window.clearTimeout(copiedTimeoutRef.current);
			}
			copiedTimeoutRef.current = window.setTimeout(() => {
				setCopied(false);
				copiedTimeoutRef.current = null;
			}, 2_000);
		} catch {
			setCopied(false);
			setCopyError('Could not copy the sign-in link. Select it above and copy manually.');
		}
	}

	function openSignInUrl() {
		if (!signInUrl) {
			return;
		}

		// Don't pass noopener in features; browsers then return null even on success.
		const opened = window.open(signInUrl, '_blank');
		if (!opened) {
			return;
		}
		try {
			opened.opener = null;
		} catch {
			// Best-effort isolation if the browser rejects opener writes.
		}
		onClearOpenErrorRef.current?.();
	}

	if (!open) {
		return null;
	}

	const overlayCopy = !signInUrl
		? {
				title: 'Preparing sign-in',
				description: 'Preparing a secure sign-in link. This usually takes a moment.'
			}
		: error
			? {
					title: 'Open the sign-in link',
					description: 'Your browser didn’t open automatically. Continue with the options below.'
				}
			: {
					title: 'Finish signing in',
					description:
						'We opened your browser to complete sign-in. Waiting for you to finish there.'
				};

	return (
		<div
			className="app-entry-shell fixed inset-0 z-50 flex items-center justify-center px-6"
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget) {
					onCancel();
				}
			}}
		>
			<div
				ref={dialogRef}
				className="border-border/70 bg-surface relative z-10 w-full max-w-md rounded-2xl border p-8 text-center shadow-[0_18px_50px_-28px_oklch(0.2_0.02_260/0.45)] outline-none"
				role="dialog"
				aria-modal="true"
				aria-labelledby="browser-signin-title"
				aria-describedby="browser-signin-desc"
				tabIndex={-1}
			>
				{!signInUrl && (
					<div className="text-muted-foreground mb-4 flex justify-center" aria-hidden="true">
						<LoaderCircle className="size-5 animate-spin" />
					</div>
				)}

				<h2
					id="browser-signin-title"
					className="font-brand text-foreground text-[1.35rem] font-semibold tracking-tight"
				>
					{overlayCopy.title}
				</h2>
				<p id="browser-signin-desc" className="text-muted-foreground mt-3 text-sm leading-[1.55]">
					{overlayCopy.description}
				</p>

				{signInUrl && (
					<p
						className="text-muted-foreground mt-6 max-h-24 overflow-y-auto font-mono text-[11px] leading-5 break-all select-all"
						title={signInUrl}
					>
						{signInUrl}
					</p>
				)}

				{error && (
					<p className="text-destructive mt-4 text-sm" role="alert">
						{error}
					</p>
				)}
				{copyError && (
					<p className="mt-4 text-sm text-amber-700" role="alert">
						{copyError}
					</p>
				)}

				<div className="mt-6 flex flex-wrap items-center justify-center gap-3">
					{signInUrl ? (
						<>
							<Button onclick={openSignInUrl}>
								<ExternalLink className="size-4" aria-hidden="true" />
								Open browser
							</Button>
							<Button variant="outline" onclick={() => void copySignInUrl()}>
								{copied ? (
									<>
										<Check className="size-4" aria-hidden="true" />
										Copied
									</>
								) : (
									<>
										<Copy className="size-4" aria-hidden="true" />
										Copy link
									</>
								)}
							</Button>
						</>
					) : (
						<span className="text-muted-foreground border-border inline-flex h-10 items-center justify-center gap-2 rounded-full border px-4 text-sm">
							Preparing link…
						</span>
					)}
				</div>

				<div className="mt-6">
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground decoration-foreground/30 hover:decoration-foreground text-[13px] underline underline-offset-4 transition-colors"
						onClick={onCancel}
					>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}
