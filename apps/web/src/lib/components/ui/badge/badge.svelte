<script lang="ts">
	import { cva, type VariantProps } from 'class-variance-authority';

	import { cn } from '$lib/utils';

	const badgeVariants = cva(
		'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
		{
			variants: {
				variant: {
					default: 'border-transparent bg-primary/16 text-primary',
					secondary: 'border-border/70 bg-secondary/80 text-secondary-foreground',
					outline: 'border-border/85 bg-background/30 text-muted-foreground'
				}
			},
			defaultVariants: {
				variant: 'default'
			}
		}
	);

	type Props = {
		variant?: VariantProps<typeof badgeVariants>['variant'];
		className?: string;
		children?: import('svelte').Snippet;
	};

	let { variant = 'default', className = '', children }: Props = $props();
</script>

<span class={cn(badgeVariants({ variant }), className)}>
	{@render children?.()}
</span>
