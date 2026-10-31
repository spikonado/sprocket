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
