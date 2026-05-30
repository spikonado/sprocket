<script lang="ts">
	import { cva, type VariantProps } from 'class-variance-authority';

	import { cn } from '$lib/utils';

	const buttonVariants = cva(
		'inline-flex items-center justify-center rounded-xl border border-transparent text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-50',
		{
			variants: {
				variant: {
					default: 'bg-primary text-primary-foreground hover:bg-primary/92',
					secondary:
						'border-border/80 bg-secondary/90 text-secondary-foreground hover:bg-secondary',
					outline:
						'border-border/90 bg-background/30 text-foreground hover:border-white/14 hover:bg-white/4',
					ghost: 'bg-transparent text-muted-foreground hover:bg-white/4 hover:text-foreground'
				},
				size: {
					default: 'h-10 px-4 py-2',
					sm: 'h-8 px-3 text-xs',
					lg: 'h-11 px-5',
					icon: 'size-9'
				}
			},
			defaultVariants: {
				variant: 'default',
				size: 'default'
			}
		}
	);

	type Props = {
		type?: 'button' | 'submit' | 'reset';
		variant?: VariantProps<typeof buttonVariants>['variant'];
		size?: VariantProps<typeof buttonVariants>['size'];
		className?: string;
		disabled?: boolean;
		onclick?: (event: MouseEvent) => void;
		children?: import('svelte').Snippet;
	};

	let {
		type = 'button',
		variant = 'default',
		size = 'default',
		className = '',
		disabled = false,
		onclick,
		children
	}: Props = $props();
</script>

<button {type} {disabled} class={cn(buttonVariants({ variant, size }), className)} {onclick}>
	{@render children?.()}
</button>
