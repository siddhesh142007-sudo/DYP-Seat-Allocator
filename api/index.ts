/**
 * Vercel Function entrypoint for the Express API.
 *
 * `vercel.json` rewrites `/api/(.*)` here. Rewrites are URL-masking: the
 * browser keeps the original URL and the function receives the original path in
 * `req.url`, so Express routes normally and no path rewriting is needed here.
 */
import { createApp } from '../backend/dist/app.js';

export default createApp();
