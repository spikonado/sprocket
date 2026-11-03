import type { Id, TableNames } from '@convex/_generated/dataModel';
import type { SystemTableNames } from 'convex/server';
import { z } from 'zod';

export function convexId<Table extends TableNames | SystemTableNames>() {
	return z.custom<Id<Table>>((value) => z.string().safeParse(value).success);
}
