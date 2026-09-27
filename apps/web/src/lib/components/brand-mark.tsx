import { cn } from '$lib/utils';

export default function BrandMark({
	class: className = '',
	size = 'md',
	onclick,
	label
}: {
	class?: string;
	size?: 'sm' | 'md';
	onclick?: () => void;
	label?: string;
}) {
	const sizeClass = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7';
	const textClass = size === 'sm' ? 'text-lg' : 'text-[1.15rem]';

	const content = (
		<>
			<img src="/logo.png" alt="" className={cn('shrink-0', sizeClass)} />
			<span
				className={cn(
					'font-brand text-foreground truncate font-semibold tracking-tight',
					textClass
				)}
			>
				Sprocket
			</span>
		</>
	);

	if (onclick) {
		return (
			<button
				type="button"
				className={cn('flex min-w-0 items-center gap-2', className)}
				aria-label={label}
				title={label}
				onClick={onclick}
			>
				{content}
			</button>
		);
	}

	return <div className={cn('flex min-w-0 items-center gap-2', className)}>{content}</div>;
}
