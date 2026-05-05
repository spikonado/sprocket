import { AuthKit } from '@convex-dev/workos-authkit';
import { components } from './_generated/api';
import type { DataModel } from './_generated/dataModel';

export const authKit = new AuthKit<DataModel>(components.workOSAuthKit);
