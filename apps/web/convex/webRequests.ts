import { v } from 'convex/values';
import { retiredCloudRequest } from '@convex/lib/agentErrors';
import { mutation } from '@convex/_generated/server';

export const start = mutation({ args: v.any(), handler: retiredCloudRequest });
