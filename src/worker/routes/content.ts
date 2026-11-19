import { Hono } from 'hono';
import { postRoutes } from './content-posts';
import { runRoutes } from './content-runs';
import { topicRoutes } from './content-topics';
import type { AppEnv } from '../types';

/**
 * Content surface, mounted at /content by the app.
 *
 * Split by concern in Phase 8 (the file had passed 250 lines):
 *   content-topics.ts  queue + AI planning + hook library
 *   content-posts.ts   post listing, detail, owner edits, draft-option selection
 *   content-runs.ts    sync / generate now / counters
 * Paths are unchanged, so nothing outside this folder moved.
 */
export const contentRoutes = new Hono<AppEnv>();

contentRoutes.route('/', topicRoutes);
contentRoutes.route('/', postRoutes);
contentRoutes.route('/', runRoutes);
