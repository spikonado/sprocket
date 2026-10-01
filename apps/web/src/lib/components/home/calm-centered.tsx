import { useLayoutEffect, type ReactNode } from 'react';
import BrandMark from '$lib/components/brand-mark';
import { forceEntryTheme } from '$lib/theme';
import { cn } from '$lib/utils';

export default function CalmCentered({
	title,
	description = null,
	busy = false,
	class: className = '',
	children,
	actions
}: {
	title: string;
	description?: string | null;
	busy?: boolean;
	class?: string;
	children?: ReactNode;
	actions?: ReactNode;
}) {
	useLayoutEffect(forceEntryTheme, []);

	return (
		<div
			className={cn(
				'app-entry-shell relative flex min-h-screen items-center justify-center px-8 py-10 text-center',
				className
			)}
		>
			<div
				className="relative z-10 w-full max-w-md"
				aria-busy={busy || undefined}
				aria-live={busy ? 'polite' : undefined}
			>
				<div className="mb-8 flex justify-center">
					<BrandMark />
				</div>
				<h1 className="font-brand text-foreground text-[1.5rem] font-semibold tracking-tight">
					{title}
				</h1>
				{description && (
					<p className="text-muted-foreground mt-3 text-sm leading-[1.55]">{description}</p>
				)}
				{children && (
					<div className="mt-5 space-y-4 text-left [&:not(:has(*))]:mt-0 [&:not(:has(*))]:hidden">
						{children}
					</div>
				)}
				{actions && (
					<div className="mt-6 flex flex-wrap items-center justify-center gap-3 [&:not(:has(*))]:mt-0 [&:not(:has(*))]:hidden">
						{actions}
					</div>
				)}
			</div>
		</div>
	);
}
