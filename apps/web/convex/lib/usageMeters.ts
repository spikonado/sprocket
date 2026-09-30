export const usageMeters = [
	{
		id: 'modelUsage',
		label: 'Model usage',
		noun: 'model usage',
		description: 'More expensive models use up more usage.'
	}
] as const;

export type UsageMeterId = (typeof usageMeters)[number]['id'];

export const usagePeriods = ['weekly', 'monthly'] as const;
export type UsagePeriod = (typeof usagePeriods)[number];
