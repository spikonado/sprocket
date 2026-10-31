import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { shadcnComponentDefinitions } from '@json-render/shadcn/catalog';
import { z } from 'zod';

const chartProps = z.object({
	title: z.string().nullable(),
	data: z.array(z.object({ label: z.string(), value: z.number() }))
});

export const jsonRenderCatalog = defineCatalog(schema, {
	components: {
		...shadcnComponentDefinitions,
		Metric: {
			props: z.object({
				label: z.string(),
				value: z.string(),
				detail: z.string().nullable()
			}),
			description: 'One headline number with its label. Put several in a Grid for a dashboard',
			example: { label: 'Pass rate', value: '96.5%', detail: '+1.2% this week' }
		},
		BarGraph: {
			props: chartProps,
			description: 'Vertical bar chart. Values must be zero or above',
			example: { title: 'Builds per day', data: [{ label: 'Mon', value: 12 }] }
		},
		LineGraph: {
			props: chartProps,
			description: 'Line chart through the data points in order',
			example: { title: 'Latency (ms)', data: [{ label: '09:00', value: 120 }] }
		}
	},
	actions: {}
});
