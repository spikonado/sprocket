import { Check, Copy, Download, LoaderCircle, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type ViewerImage = {
	url: string;
	name: string;
	mediaType: string;
};

function extensionForMediaType(mediaType: string): string | undefined {
	switch (mediaType) {
		case 'image/jpeg':
			return 'jpg';
		case 'image/png':
			return 'png';
		case 'image/gif':
			return 'gif';
		case 'image/webp':
			return 'webp';
		case 'image/svg+xml':
			return 'svg';
		case 'image/avif':
			return 'avif';
		case 'image/bmp':
			return 'bmp';
		default:
			return undefined;
	}
}

function downloadFilename(current: ViewerImage) {
	const name = current.name.trim() || 'image';
	const extension = extensionForMediaType(current.mediaType);

	if (!extension) {
		return name;
	}

	const existingExtension = name.match(/\.([a-z0-9]{2,5})$/i);

	if (!existingExtension) {
		return `${name}.${extension}`;
	}

	const validExtensions = current.mediaType === 'image/jpeg' ? ['jpg', 'jpeg'] : [extension];

	return validExtensions.includes(existingExtension[1].toLowerCase())
		? name
		: `${name.slice(0, -existingExtension[0].length)}.${extension}`;
}

async function fetchImageBlob(current: ViewerImage) {
	const response = await fetch(current.url, { referrerPolicy: 'no-referrer' });

	if (!response.ok) {
		throw new Error(`Fetch failed with status ${response.status}`);
	}

	return response.blob();
}

/** Clipboard image writes are PNG-only in most browsers, so re-encode when needed. */
async function toPngBlob(blob: Blob) {
	if (blob.type === 'image/png') {
		return blob;
	}

	const bitmap = await createImageBitmap(blob);

	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context = canvas.getContext('2d');

		if (!context) {
			throw new Error('Canvas 2D context unavailable');
		}

		context.drawImage(bitmap, 0, 0);

		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(png) => (png ? resolve(png) : reject(new Error('PNG encoding failed'))),
				'image/png'
			);
		});
	} finally {
		bitmap.close();
	}
}

const actionButtonClass =
	'inline-flex size-9 items-center justify-center rounded-lg border border-white/15 bg-black/65 text-white shadow-lg backdrop-blur-sm transition hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none aria-disabled:cursor-wait aria-disabled:opacity-60';

export default function ImageViewer({
	image,
	onClose
}: {
	image: ViewerImage | null;
	onClose: () => void;
}) {
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const [copied, setCopied] = useState(false);
	const [copying, setCopying] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [copyError, setCopyError] = useState<string | null>(null);
	const [downloadError, setDownloadError] = useState<string | null>(null);
	const copiedTimeoutRef = useRef<number | null>(null);
	const generationRef = useRef(0);
	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		generationRef.current += 1;

		if (!image) {
			return;
		}

		setCopied(false);
		setCopying(false);
		setDownloading(false);
		setCopyError(null);
		setDownloadError(null);

		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;

		let disposed = false;
		queueMicrotask(() => {
			if (!disposed) {
				dialogRef.current?.focus();
			}
		});

		const previousBodyOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		function handleWindowKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				onCloseRef.current();

				return;
			}

			const dialogEl = dialogRef.current;

			if (event.key !== 'Tab' || !dialogEl) {
				return;
			}

			const focusable = Array.from(
				dialogEl.querySelectorAll<HTMLElement>(
					'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			).filter((element) => !element.hasAttribute('hidden'));

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
			disposed = true;
			window.removeEventListener('keydown', handleWindowKeydown, true);
			document.body.style.overflow = previousBodyOverflow;

			if (copiedTimeoutRef.current !== null) {
				window.clearTimeout(copiedTimeoutRef.current);
				copiedTimeoutRef.current = null;
			}

			if (previouslyFocused?.isConnected) {
				previouslyFocused.focus();
			}
		};
	}, [image]);

	async function copyImage(current: ViewerImage) {
		if (copying) {
			return;
		}

		const generation = generationRef.current;
		setCopying(true);
		setCopyError(null);
		setDownloadError(null);

		try {
			if (!globalThis.ClipboardItem) {
				throw new Error('Clipboard images unsupported');
			}

			const png = fetchImageBlob(current).then(toPngBlob);
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);

			if (generation !== generationRef.current) {
				return;
			}

			setCopied(true);

			if (copiedTimeoutRef.current !== null) {
				window.clearTimeout(copiedTimeoutRef.current);
			}

			copiedTimeoutRef.current = window.setTimeout(() => {
				setCopied(false);
				copiedTimeoutRef.current = null;
			}, 2_000);
		} catch {
			if (generation === generationRef.current) {
				setCopied(false);
				setCopyError('Could not copy the image to the clipboard.');
			}
		} finally {
			if (generation === generationRef.current) {
				setCopying(false);
			}
		}
	}

	async function downloadImage(current: ViewerImage) {
		if (downloading) {
			return;
		}

		const generation = generationRef.current;
		setDownloading(true);
		setCopyError(null);
		setDownloadError(null);

		try {
			const blob = await fetchImageBlob(current);

			if (generation !== generationRef.current) {
				return;
			}

			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = objectUrl;
			anchor.download = downloadFilename({ ...current, mediaType: blob.type || current.mediaType });
			document.body.append(anchor);

			try {
				anchor.click();
			} finally {
				anchor.remove();
				window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
			}
		} catch {
			if (generation === generationRef.current) {
				setDownloadError('Could not download the image.');
			}
		} finally {
			if (generation === generationRef.current) {
				setDownloading(false);
			}
		}
	}

	if (!image) return null;
	const current = image;

	return (
		<div
			className="bg-background/92 fixed inset-0 z-300 flex items-center justify-center px-3 py-4 sm:px-6 sm:py-12"
			data-image-viewer=""
			role="presentation"
			onClick={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div
				ref={dialogRef}
				className="relative inline-flex max-h-full max-w-full outline-none"
				role="dialog"
				aria-modal="true"
				aria-label={`Image preview: ${current.name}`}
				tabIndex={-1}
			>
				<img
					src={current.url}
					alt={current.name}
					referrerPolicy="no-referrer"
					className="border-border block max-h-[calc(100dvh-2rem)] max-w-full rounded-2xl border object-contain sm:max-h-[calc(100dvh-6rem)]"
				/>
				<button
					type="button"
					className={`${actionButtonClass} absolute top-3 right-3`}
					aria-label="Close image preview"
					onClick={onClose}
				>
					<X className="size-4" aria-hidden="true" />
				</button>

				<div className="absolute right-3 bottom-3 flex items-center gap-2">
					<button
						type="button"
						className={actionButtonClass}
						aria-disabled={copying}
						aria-label={copying ? 'Copying image' : copied ? 'Image copied' : 'Copy image'}
						title={copying ? 'Copying image' : copied ? 'Image copied' : 'Copy image'}
						onClick={() => void copyImage(current)}
					>
						{copying ? (
							<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
						) : copied ? (
							<Check className="size-4" aria-hidden="true" />
						) : (
							<Copy className="size-4" aria-hidden="true" />
						)}
					</button>
					<button
						type="button"
						className={actionButtonClass}
						aria-disabled={downloading}
						aria-label={downloading ? 'Downloading image' : 'Download image'}
						title={downloading ? 'Downloading image' : 'Download image'}
						onClick={() => void downloadImage(current)}
					>
						{downloading ? (
							<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
						) : (
							<Download className="size-4" aria-hidden="true" />
						)}
					</button>
				</div>
				<span className="sr-only" aria-live="polite">
					{copying
						? 'Copying image'
						: copied
							? 'Image copied'
							: downloading
								? 'Downloading image'
								: ''}
				</span>

				{copyError || downloadError ? (
					<p
						className="border-border absolute right-3 bottom-14 max-w-[min(20rem,calc(100%-1.5rem))] rounded-lg border bg-black/80 px-3 py-2 text-xs text-amber-100 shadow-lg backdrop-blur-sm"
						role="alert"
					>
						{copyError ?? downloadError}
					</p>
				) : null}
			</div>
		</div>
	);
}
