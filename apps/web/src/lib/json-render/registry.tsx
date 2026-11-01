import { defineRegistry } from '@json-render/react';
import { shadcnComponents } from '@json-render/shadcn';
import { jsonRenderCatalog } from './catalog';
import { Alert, BarGraph, Card, LineGraph, Link, Metric, Stack, Table } from './components';

export const { registry: jsonRenderRegistry } = defineRegistry(jsonRenderCatalog, {
	components: {
		...shadcnComponents,
		Card,
		Stack,
		Table,
		Alert,
		Link,
		Metric,
		BarGraph,
		LineGraph
	}
});
