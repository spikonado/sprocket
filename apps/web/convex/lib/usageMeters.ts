export const usageMeters = [
	{
		id: 'modelUsage',
		label: 'Usage',
		description: 'More expensive models use up more usage.'
	}
] as const;

export type UsageMeterId = (typeof usageMeters)[number]['id'];
