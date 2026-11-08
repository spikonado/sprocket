import { useRef } from 'react';
import screenshot from '@/assets/sprocket.webp';
import { track } from '@/lib/analytics/client';

const alt =
	'Sprocket running parallel agent threads, showing AI cost per reply, designing a PCB in KiCad, asking questions before it guesses, keeping commands running, and connecting a ChatGPT subscription or API key';

export default function SprocketScreenshot() {
	const dialog = useRef<HTMLDialogElement>(null);
	const close = () => dialog.current?.close();

	return (
		<>
			<button
				type="button"
				className="block w-full cursor-zoom-in border-0 bg-transparent p-0 text-left"
				aria-label="View Sprocket screenshot full size"
				onClick={(event) => {
					dialog.current?.showModal();
					track('product_media_opened', { media: 'sprocket_screenshot' }, event.currentTarget);
				}}
			>
				<img
					src={screenshot.src}
					width={screenshot.width}
					height={screenshot.height}
					alt={alt}
					className="h-auto w-full"
					loading="lazy"
					decoding="async"
				/>
			</button>

			<dialog
				ref={dialog}
				aria-label="Sprocket screenshot"
				className="backdrop:bg-ink/90 m-0 h-full max-h-none w-full max-w-none items-center justify-center bg-transparent p-4 open:flex sm:p-8"
				onClick={(event) => {
					if (event.target === event.currentTarget) close();
				}}
			>
				<button
					type="button"
					className="bg-ink/60 hover:bg-ink/80 absolute top-4 right-4 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/20 text-white transition-colors focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none"
					aria-label="Close full size image"
					onClick={close}
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						className="h-5 w-5"
						aria-hidden="true"
					>
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				</button>
				<img
					src={screenshot.src}
					width={screenshot.width}
					height={screenshot.height}
					alt={alt}
					className="h-auto max-h-full w-auto max-w-full rounded-lg object-contain shadow-2xl"
				/>
			</dialog>
		</>
	);
}
