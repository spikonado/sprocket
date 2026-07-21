/** Flat web-tools meter cost for one URL scrape. */
export const URL_SCRAPE_USAGE_UNITS = 1.5;
/** Flat web-tools meter cost for one web search (independent of result count). */
export const WEB_SEARCH_USAGE_UNITS = 7;

export const usageMeters = [
	{
		id: 'modelUsage',
		label: 'Model usage',
		noun: 'model usage',
		description: 'More expensive models use up more usage.'
	},
	{
		id: 'webTools',
		label: 'Web tools',
		noun: 'web tools',
		description: 'Web search and URL scrape share this quota.'
	}
] as const;

export type UsageMeterId = (typeof usageMeters)[number]['id'];

export const usagePeriods = ['weekly', 'monthly'] as const;
export type UsagePeriod = (typeof usagePeriods)[number];
