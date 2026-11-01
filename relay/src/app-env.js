// Shared JSDoc types for the relay. This module has no runtime code.

/**
 * Bindings the Worker sees. `Env` comes from `wrangler types`; the GitHub App
 * credentials are Worker secrets, so the generated types do not list them.
 * @typedef {object} RelaySecrets
 * @property {string} [GITHUB_CLIENT_ID]
 * @property {string} [GITHUB_CLIENT_SECRET]
 */

/**
 * @typedef {{ Bindings: Env & RelaySecrets }} AppEnv
 */

/**
 * @typedef {import('hono').Context<AppEnv>} AppContext
 */

export {};
