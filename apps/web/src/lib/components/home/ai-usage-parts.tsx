import type { ReactNode } from 'react';
import { formatTokens, type TokenTypeAmounts } from '$lib/chat/ai-usage';

const tokenTypes = [
	{ key: 'uncachedInput', label: 'Uncached input', color: 'oklch(0.55 0.13 250)' },
	{ key: 'cacheRead', label: 'Cache read', color: 'oklch(0.78 0.08 230)' },
	{ key: 'cacheWrite', label: 'Cache write', color: 'oklch(0.72 0.12 75)' },
	{ key: 'output', label: 'Output', color: 'oklch(0.6 0.14 25)' }
] as const;

export const modelColors = [
	'oklch(0.62 0.13 45)',
	'oklch(0.55 0.13 250)',
	'oklch(0.66 0.11 165)',
	'oklch(0.7 0.09 300)',
	'oklch(0.72 0.12 95)',
	'oklch(0.6 0.12 10)',
	'oklch(0.6 0.08 210)',
	'oklch(0.5 0.05 260)'
];

export function UsageLabel({ children }: { children: ReactNode }) {
	return (
		<p className="text-muted-foreground font-mono text-[11px] tracking-[0.18em] uppercase">
			{children}
		</p>
	);
}

export function UsageSegmented<Id extends string>({
	label,
	options,
	value,
	onChange
}: {
	label: string;
	options: readonly { id: Id; label: string }[];
	value: Id;
	onChange: (id: Id) => void;
}) {
	return (
		<div
			role="group"
			aria-label={label}
			className="bg-hover-fill inline-flex gap-0.5 rounded-[10px] p-[3px]"
		>
			{options.map((option) => (
				<button
					key={option.id}
					type="button"
					aria-pressed={value === option.id}
					onClick={() => onChange(option.id)}
					className={
						value === option.id
							? 'bg-surface text-foreground rounded-lg px-2.5 py-1 text-[12.5px] shadow-[0_0_0_1px_var(--hairline)]'
							: 'text-muted-foreground hover:text-foreground cursor-pointer rounded-lg px-2.5 py-1 text-[12.5px] transition'
					}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function UsageStat({
	label,
	value,
	detail
}: {
	label: string;
	value: string;
	detail?: string;
}) {
	return (
		<div className="min-w-0">
			<p className="text-muted-foreground text-[12px]">{label}</p>
			<p className="text-foreground mt-1 text-[1.4rem] leading-tight tracking-[-0.03em] tabular-nums">
				{value}
			</p>
			{detail ? (
				<p className="text-muted-foreground mt-0.5 truncate text-[11.5px]">{detail}</p>
			) : null}
		</div>
	);
}

export type ShareItem = {
	key: string;
	label: string;
	detail?: string;
	value: string;
	share: number;
};

/** Rows with a bar for each item's share, for comparing models or subagents at a glance. */
export function UsageShareList({ items }: { items: readonly ShareItem[] }) {
	return (
		<ul className="mt-2 space-y-2.5 text-[12.5px]">
			{items.map((item) => (
				<li key={item.key}>
					<div className="flex items-baseline gap-2">
						<span className="text-foreground min-w-0 flex-1 truncate">
							{item.label}
							{item.detail ? <span className="text-muted-foreground"> · {item.detail}</span> : null}
						</span>
						<span className="text-muted-foreground shrink-0 tabular-nums">{item.value}</span>
					</div>
					<div className="bg-hover-fill mt-1 h-1 overflow-hidden rounded-full" aria-hidden="true">
						<div
							className="bg-foreground/35 h-full rounded-full"
							style={{ width: `${Math.max(item.share * 100, item.share > 0 ? 1 : 0)}%` }}
						></div>
					</div>
				</li>
			))}
		</ul>
	);
}

export function TokenTypeBreakdown({
	amounts,
	format = formatTokens
}: {
	amounts: TokenTypeAmounts;
	format?: (amount: number) => string;
}) {
	const total = tokenTypes.reduce((sum, type) => sum + amounts[type.key], 0);

	return (
		<div>
			<div className="bg-hover-fill flex h-2 overflow-hidden rounded-full" aria-hidden="true">
				{total > 0
					? tokenTypes.map((type) => (
							<div
								key={type.key}
								style={{
									width: `${(amounts[type.key] / total) * 100}%`,
									background: type.color
								}}
							></div>
						))
					: null}
			</div>
			<dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
				{tokenTypes.map((type) => (
					<div key={type.key} className="flex items-center gap-2">
						<span
							className="size-2 shrink-0 rounded-[2px]"
							style={{ background: type.color }}
						></span>
						<dt className="text-muted-foreground flex-1">{type.label}</dt>
						<dd className="text-foreground tabular-nums">{format(amounts[type.key])}</dd>
					</div>
				))}
				<div className="text-muted-foreground col-start-2 flex pl-4 text-[11.5px]">
					<dt className="flex-1">of which reasoning</dt>
					<dd className="tabular-nums">{format(amounts.reasoning)}</dd>
				</div>
			</dl>
		</div>
	);
}
