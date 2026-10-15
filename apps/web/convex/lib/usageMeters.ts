export const usageMeters = [
	{
		id: 'modelUsage',
		label: 'Model usage',
		description: 'More expensive models use up more usage.'
	}
] as const;

export type UsageMeterId = (typeof usageMeters)[number]['id'];
