import type { MouseEvent, ReactNode } from 'react';
import { cn } from '$lib/utils';

export default function Button({
	type = 'button',
	variant = 'default',
	className = '',
	disabled = false,
	href,
	onclick,
	children
}: {
	type?: 'button' | 'submit' | 'reset';
	variant?: 'default' | 'outline';
	className?: string;
	disabled?: boolean;
	href?: string;
	onclick?: (event: MouseEvent) => void;
	children?: ReactNode;
}) {
	const variantClass =
		variant === 'outline'
			? 'border-border bg-surface/80 text-foreground hover:bg-hover-fill'
			: 'bg-primary text-primary-foreground hover:opacity-90';
	const sharedClass = cn(
		'focus-visible:ring-ring/50 inline-flex h-10 items-center justify-center gap-2 rounded-full border border-transparent px-5 py-2 text-sm font-medium transition-opacity focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
		variantClass,
		className
	);

	if (href && !disabled) {
		return (
			<a href={href} className={sharedClass} onClick={onclick}>
				{children}
			</a>
		);
	}

	return (
		<button type={type} disabled={disabled} className={sharedClass} onClick={onclick}>
			{children}
		</button>
	);
}
