import type { Id, TableNames } from '@convex/_generated/dataModel';
import type { SystemTableNames } from 'convex/server';
import { z } from 'zod';

const idString = z.string();

export function convexId<Table extends TableNames | SystemTableNames>() {
	return z.custom<Id<Table>>((value) => idString.safeParse(value).success);
}
