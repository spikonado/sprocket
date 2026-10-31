import type { BaseComponentProps } from '@json-render/react';
import { createContext, useContext, type ReactNode } from 'react';
import { cn } from '$lib/utils';

/** True while rendering a spec whose root element is a Card. */
export const FlatRootCard = createContext(false);

const CARD_WIDTHS = {
	sm: 'max-w-xs',
	md: 'max-w-sm',
	lg: 'max-w-md',
	full: 'w-full'
};

type CardProps = BaseComponentProps<{
	title: string | null;
	description: string | null;
	maxWidth: keyof typeof CARD_WIDTHS | null;
	centered: boolean | null;
}>;

// The root card sits flat on the thread like an HTML visual's page; nested cards are boxes.
export function Card({ props, children }: CardProps) {
	const flat = useContext(FlatRootCard);

	return (
		<FlatRootCard.Provider value={false}>
			<section
				className={cn(
					'flex min-w-0 flex-col gap-3',
					CARD_WIDTHS[props.maxWidth ?? 'full'],
					props.centered && 'mx-auto',
					!flat && 'bg-card text-card-foreground rounded-lg border p-4'
				)}
			>
				{props.title || props.description ? (
					<header className="flex flex-col gap-0.5">
						{props.title ? (
							<h3 className={cn('font-semibold tracking-tight', flat && 'text-[15px]')}>
								{props.title}
							</h3>
						) : null}
						{props.description ? (
							<p className="text-muted-foreground">{props.description}</p>
						) : null}
					</header>
				) : null}
				{children}
			</section>
		</FlatRootCard.Provider>
	);
}

type TableProps = BaseComponentProps<{
	columns: string[];
	rows: string[][];
	caption: string | null;
}>;

export function Table({ props }: TableProps) {
	return (
		<div className="min-w-0 overflow-x-auto">
			<table className="w-full border-collapse text-left">
				{props.caption ? (
					<caption className="text-muted-foreground caption-bottom pt-2 text-left text-xs">
						{props.caption}
					</caption>
				) : null}
				<thead className="text-muted-foreground">
					<tr className="border-b">
						{(props.columns ?? []).map((column, index) => (
							<th key={index} className="px-2.5 py-2 font-medium first:pl-0">
								{column}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{(props.rows ?? []).map((row, rowIndex) => (
						<tr key={rowIndex} className="border-b last:border-0">
							{row.map((cell, cellIndex) => (
								<td key={cellIndex} className="px-2.5 py-2 first:pl-0">
									{String(cell)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const STACK_GAPS = { none: 'gap-0', sm: 'gap-2', md: 'gap-3', lg: 'gap-4', xl: 'gap-6' };

const STACK_ALIGNS = {
	start: 'items-start',
	center: 'items-center',
	end: 'items-end',
	stretch: 'items-stretch'
};

const STACK_JUSTIFIES = {
	start: 'justify-start',
	center: 'justify-center',
	end: 'justify-end',
	between: 'justify-between',
	around: 'justify-around'
};

type StackProps = BaseComponentProps<{
	direction: 'horizontal' | 'vertical' | null;
	gap: keyof typeof STACK_GAPS | null;
	align: keyof typeof STACK_ALIGNS | null;
	justify: keyof typeof STACK_JUSTIFIES | null;
}>;

// Unlike shadcn's, a vertical stack stretches its children to the message width by default.
export function Stack({ props, children }: StackProps) {
	const horizontal = props.direction === 'horizontal';

	return (
		<div
			className={cn(
				'flex min-w-0',
				horizontal ? 'flex-row flex-wrap' : 'flex-col',
				STACK_GAPS[props.gap ?? 'md'],
				STACK_ALIGNS[props.align ?? (horizontal ? 'center' : 'stretch')],
				STACK_JUSTIFIES[props.justify ?? 'start']
			)}
		>
			{children}
		</div>
	);
}

type MetricProps = BaseComponentProps<{
	label: string;
	value: string;
	detail: string | null;
}>;

export function Metric({ props }: MetricProps) {
	return (
		<div className="bg-card text-card-foreground flex min-w-0 flex-col gap-1 rounded-lg border p-4">
			<span className="text-muted-foreground text-xs">{props.label}</span>
			<span className="truncate text-2xl font-semibold tracking-tight tabular-nums">
				{props.value}
			</span>
			{props.detail ? <span className="text-muted-foreground text-xs">{props.detail}</span> : null}
		</div>
	);
}

const ALERT_TONES = {
	info: 'border-sky-500/25 bg-sky-500/10 text-sky-800 dark:text-sky-200',
	success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
	warning: 'border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-200',
	error: 'border-rose-500/25 bg-rose-500/10 text-rose-800 dark:text-rose-200'
};

type AlertProps = BaseComponentProps<{
	title: string;
	message: string | null;
	type: keyof typeof ALERT_TONES | null;
}>;

export function Alert({ props }: AlertProps) {
	return (
		<div
			role="alert"
			className={cn('rounded-lg border px-3.5 py-3', ALERT_TONES[props.type ?? 'info'])}
		>
			<p className="font-medium">{props.title}</p>
			{props.message ? <p className="opacity-90">{props.message}</p> : null}
		</div>
	);
}

type LinkProps = BaseComponentProps<{ label: string; href: string }>;

// The shadcn link navigates the app itself, so this one opens a new tab instead.
export function Link({ props, on }: LinkProps) {
	return (
		<a
			href={props.href}
			target="_blank"
			rel="noopener noreferrer"
			className="text-accent-strong font-medium underline-offset-4 hover:underline"
			onClick={(event) => {
				const press = on('press');

				if (press.shouldPreventDefault) event.preventDefault();
				press.emit();
			}}
		>
			{props.label}
		</a>
	);
}

type ChartProps = BaseComponentProps<{
	title: string | null;
	data: { label: string; value: number }[];
}>;

const CHART_HEIGHT = 140;

function ChartFrame({ title, children }: { title: string | null; children: ReactNode }) {
	return (
		<figure className="m-0 flex min-w-0 flex-col gap-2">
			{title ? <figcaption className="font-medium">{title}</figcaption> : null}
			{children}
		</figure>
	);
}

export function BarGraph({ props }: ChartProps) {
	const data = props.data ?? [];
	const max = Math.max(1, ...data.map((point) => point.value));

	return (
		<ChartFrame title={props.title}>
			<div className="flex items-end gap-3 border-b" style={{ height: CHART_HEIGHT }}>
				{data.map((point, index) => (
					<div key={index} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1">
						<span className="text-muted-foreground text-xs tabular-nums">{point.value}</span>
						<div className="flex w-full flex-1 items-end justify-center">
							<div
								className="w-full max-w-10 rounded-t-[4px] bg-[var(--chart-1)]"
								style={{ height: `${(Math.max(0, point.value) / max) * 100}%`, minHeight: 2 }}
							/>
						</div>
					</div>
				))}
			</div>
			<div className="flex gap-3">
				{data.map((point, index) => (
					<span
						key={index}
						className="text-muted-foreground min-w-0 flex-1 truncate text-center text-xs"
					>
						{point.label}
					</span>
				))}
			</div>
		</ChartFrame>
	);
}

const LINE_WIDTH = 300;

const LINE_PADDING = 6;

export function LineGraph({ props }: ChartProps) {
	const data = props.data ?? [];
	const values = data.map((point) => point.value);
	const min = Math.min(...values);
	const range = Math.max(...values) - min || 1;
	const step = data.length > 1 ? (LINE_WIDTH - LINE_PADDING * 2) / (data.length - 1) : 0;

	const points = data.map((point, index) => ({
		x: data.length === 1 ? LINE_WIDTH / 2 : LINE_PADDING + index * step,
		y: LINE_PADDING + (1 - (point.value - min) / range) * (CHART_HEIGHT - LINE_PADDING * 2)
	}));

	return (
		<ChartFrame title={props.title}>
			<div className="relative border-b" style={{ height: CHART_HEIGHT }}>
				<svg
					viewBox={`0 0 ${LINE_WIDTH} ${CHART_HEIGHT}`}
					preserveAspectRatio="none"
					className="absolute inset-0 size-full"
					role="img"
					aria-label={props.title ?? 'Line chart'}
				>
					<polyline
						points={points.map(({ x, y }) => `${x},${y}`).join(' ')}
						fill="none"
						stroke="var(--chart-1)"
						strokeWidth={2}
						strokeLinejoin="round"
						vectorEffect="non-scaling-stroke"
					/>
				</svg>
				{/* Dots are HTML so the stretched SVG doesn't turn them into ovals. */}
				{points.map(({ x, y }, index) => (
					<span
						key={index}
						className="border-background absolute size-2 -translate-1/2 rounded-full border bg-[var(--chart-1)]"
						style={{ left: `${(x / LINE_WIDTH) * 100}%`, top: `${(y / CHART_HEIGHT) * 100}%` }}
						title={`${data[index].label}: ${data[index].value}`}
					/>
				))}
			</div>
			<div className="text-muted-foreground flex justify-between gap-2 text-xs">
				{data.map((point, index) => (
					<span key={index} className="truncate">
						{point.label}
					</span>
				))}
			</div>
		</ChartFrame>
	);
}
