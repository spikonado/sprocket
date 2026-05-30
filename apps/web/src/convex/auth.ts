import { AuthKit } from '@convex-dev/workos-authkit';
import { components } from '@convex/_generated/api';
import type { DataModel } from '@convex/_generated/dataModel';

export const authKit = new AuthKit<DataModel>(components.workOSAuthKit);
