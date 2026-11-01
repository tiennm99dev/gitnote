import { Hono } from 'hono';
import { gitProxy } from './git-proxy.js';
import { jsonError } from './json-error.js';
import { oauthGithub } from './oauth-github.js';
import { originGuard } from './origin.js';
import { rateLimit } from './rate-limit.js';

/** @type {Hono<import('./app-env.js').AppEnv>} */
const app = new Hono();

/**
 * Headers on every /api/* answer, whatever produced it. A relay response is
 * data, never a page: even if a host's bytes slipped through, the browser
 * must not sniff them into HTML, run their scripts or frame them on the app
 * origin.
 */
const API_RESPONSE_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'"
};

app.use('/api/*', async (c, next) => {
	await next();
	// Re-wrap so the headers are mutable whatever produced the response.
	c.res = new Response(c.res.body, c.res);
	for (const [name, value] of Object.entries(API_RESPONSE_HEADERS)) c.res.headers.set(name, value);
});
app.use('/api/*', originGuard);
app.use('/api/*', rateLimit('API_LIMITER'));
app.use('/api/oauth/*', rateLimit('OAUTH_LIMITER'));

// Liveness probe for deploy checks and local development. It reads nothing
// from the request and returns no user data.
app.get('/api/health', (c) => c.json({ status: 'ok' }));

app.route('/api/oauth/github', oauthGithub);
app.all('/api/git/*', gitProxy);

app.all('/api/*', () => jsonError(404, 'not_found', 'No such relay endpoint.'));

// Only /api/* runs the Worker first; anything else that reaches it goes to the
// static SPA.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// Replaces Hono's default handler, which logs the error: an error can carry
// request details, and the relay logs nothing.
app.onError(() => jsonError(500, 'internal_error', 'The relay hit an unexpected error.'));

export default app;
