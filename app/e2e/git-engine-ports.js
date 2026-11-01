import { tmpdir } from 'node:os';
import path from 'node:path';

/** Port of the local git server the browser tests use. */
export const E2E_GIT_PORT = 8176;

/** Port of the relay that serves the engine test page and fronts that git server. */
export const E2E_RELAY_PORT = 8789;

/** Scratch space of the engine test server; wiped when it starts. */
export const E2E_WORK_DIR = path.join(tmpdir(), 'gitnote-e2e');

/** Where the bare repos live; the browser tests create theirs here too. */
export const E2E_GIT_ROOT = path.join(E2E_WORK_DIR, 'repos');
