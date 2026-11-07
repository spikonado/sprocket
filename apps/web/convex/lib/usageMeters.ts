export const usageMeters = [{ id: 'modelUsage', label: 'Usage' }] as const;

export type UsageMeterId = (typeof usageMeters)[number]['id'];
