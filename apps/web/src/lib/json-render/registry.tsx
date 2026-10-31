import { defineRegistry, type BaseComponentProps } from '@json-render/react';
import { shadcnComponents } from '@json-render/shadcn';
import { jsonRenderCatalog } from './catalog';

type ChartProps = BaseComponentProps<{
	title: string | null;
	data: { label: string; value: number }[];
}>;

const CHART_HEIGHT = 160;

function ChartFrame({ title, children }: { title: string | null; children: React.ReactNode }) {
	return (
		<figure className="m-0 flex flex-col gap-3">
			{title ? <figcaption className="text-sm font-medium">{title}</figcaption> : null}
			{children}
		</figure>
	);
}

function BarGraph({ props }: ChartProps) {
	const data = props.data ?? [];
	const max = Math.max(1, ...data.map((point) => point.value));

	return (
		<ChartFrame title={props.title}>
			<div className="flex items-end gap-2" style={{ height: CHART_HEIGHT }}>
				{data.map((point, index) => (
					<div key={index} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1">
						<span className="text-muted-foreground text-[11px] tabular-nums">{point.value}</span>
						<div className="flex w-full flex-1 items-end">
							<div
								className="w-full rounded-t-sm bg-[var(--chart-1)]"
								style={{ height: `${(Math.max(0, point.value) / max) * 100}%`, minHeight: 2 }}
							/>
						</div>
						<span className="text-muted-foreground w-full truncate text-center text-[11px]">
							{point.label}
						</span>
					</div>
				))}
			</div>
		</ChartFrame>
	);
}

const LINE_WIDTH = 300;

const LINE_PADDING = 8;

function LineGraph({ props }: ChartProps) {
	const data = props.data ?? [];
	const values = data.map((point) => point.value);
	const min = Math.min(...values);
	const range = Math.max(...values) - min || 1;
	const step = data.length > 1 ? (LINE_WIDTH - LINE_PADDING * 2) / (data.length - 1) : 0;

	const points = data.map((point, index) => ({
		x: LINE_PADDING + index * step,
		y: LINE_PADDING + (1 - (point.value - min) / range) * (CHART_HEIGHT - LINE_PADDING * 2)
	}));

	return (
		<ChartFrame title={props.title}>
			<svg
				viewBox={`0 0 ${LINE_WIDTH} ${CHART_HEIGHT}`}
				preserveAspectRatio="none"
				className="w-full"
				style={{ height: CHART_HEIGHT }}
				role="img"
				aria-label={props.title ?? 'Line chart'}
			>
				<polyline
					points={points.map(({ x, y }) => `${x},${y}`).join(' ')}
					fill="none"
					stroke="var(--chart-1)"
					strokeWidth={2}
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			<div className="text-muted-foreground flex justify-between gap-2 text-[11px]">
				{data.map((point, index) => (
					<span key={index} className="truncate" title={`${point.label}: ${point.value}`}>
						{point.label}
					</span>
				))}
			</div>
		</ChartFrame>
	);
}

export const { registry: jsonRenderRegistry } = defineRegistry(jsonRenderCatalog, {
	components: {
		...shadcnComponents,
		// The shadcn link navigates the app itself, so it opens a new tab instead.
		Link: ({ props }) => (
			<a
				href={props.href}
				target="_blank"
				rel="noopener noreferrer"
				className="text-primary text-sm font-medium underline-offset-4 hover:underline"
			>
				{props.label}
			</a>
		),
		BarGraph,
		LineGraph
	}
});
