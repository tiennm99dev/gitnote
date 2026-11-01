import { Hono } from 'hono';

const app = new Hono();

// Liveness probe for deploy checks and local development. It reads nothing
// from the request and returns no user data.
app.get('/api/health', (c) => c.json({ status: 'ok' }));

export default app;
