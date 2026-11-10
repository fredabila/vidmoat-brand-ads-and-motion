// Vercel entry point: the same Express app, run as one function.
// Static files in public/ are served by Vercel directly.
import { createApp } from '../server/index.js';

export default createApp({ env: { TRUST_PROXY: '1', ...process.env } });
