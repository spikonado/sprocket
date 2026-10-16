import type { DatabaseReader } from '@convex/_generated/server';

export async function getUiPreferences(db: DatabaseReader, userId: string) {
	return await db
		.query('uiPreferences')
		.withIndex('by_userId', (query) => query.eq('userId', userId))
		.unique();
}
