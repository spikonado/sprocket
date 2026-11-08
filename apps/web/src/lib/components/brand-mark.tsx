import sprocketLockup from '$lib/assets/sprocket-lockup.svg?raw';
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
	const mark = (
		<span
			role="img"
			aria-label="Sprocket"
			className={cn(
				'text-foreground flex shrink-0 [&>svg]:h-full [&>svg]:w-auto',
				size === 'sm' ? 'h-6' : 'h-7',
				!onclick && className
			)}
			dangerouslySetInnerHTML={{ __html: sprocketLockup }}
		/>
	);

	if (!onclick) return mark;

	return (
		<button
			type="button"
			className={cn('flex items-center', className)}
			aria-label={label}
			title={label}
			onClick={onclick}
		>
			{mark}
		</button>
	);
}
