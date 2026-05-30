import { defineApp } from 'convex/server';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';
import workOSAuthKit from '@convex-dev/workos-authkit/convex.config';

const app = defineApp();

app.use(rateLimiter);
app.use(workOSAuthKit);

export default app;
