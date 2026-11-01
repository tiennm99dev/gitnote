/**
 * The app's one auth session, wired to the sign-in settings from this build and
 * to the device's token store.
 */

import { authConfig } from './config.js';
import { relayOrigin } from '../platform/native.js';
import { createGithubAdapter } from './github.js';
import { createGitlabAdapter } from './gitlab.js';
import { createAuthSession } from './session.js';
import { createDeviceTokenStore } from './token-store.js';

export const authSession = createAuthSession({
	store: createDeviceTokenStore(),
	adapters: {
		github: createGithubAdapter({ clientId: authConfig.githubClientId, appSlug: authConfig.githubAppSlug, relayOrigin: relayOrigin() }),
		gitlab: createGitlabAdapter({ clientId: authConfig.gitlabClientId })
	}
});
