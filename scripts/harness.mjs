// Shared Playwright harness: starts Vite, launches headless Chromium with WebGL,
// collects console output and fails loudly on shader errors / exceptions.
import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOTS = path.join(ROOT, 'shots');

const GPU_FLAGS = {
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  egl: ['--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'],
  vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'],
};

export async function startServer({ production = process.env.ICARUS_PROD === '1' } = {}) {
  if (production) {
    // the built bundle in dist/ (run `npm run build` first)
    const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', preview: { port: 0, host: '127.0.0.1' } });
    const addr = server.httpServer.address();
    return { url: `http://127.0.0.1:${addr.port}/`, close: () => server.close() };
  }
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'error',
    server: { port: 0, host: '127.0.0.1' },
  });
  await server.listen();
  const addr = server.httpServer.address();
  const url = `http://127.0.0.1:${addr.port}/`;
  return { url, close: () => server.close() };
}

/** Classify console lines that indicate real problems. */
function isProblem(type, text) {
  if (type === 'error') return true;
  return /Shader Error|WebGLProgram|ERROR: \d|GL_INVALID|CONTEXT_LOST|Uncaught/i.test(text);
}

export async function launch({ width = 1280, height = 720, gpu = process.env.ICARUS_GPU || 'egl' } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: [...(GPU_FLAGS[gpu] ?? GPU_FLAGS.swiftshader), '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const logs = [];
  const problems = [];
  page.on('console', (msg) => {
    const text = msg.text();
    logs.push(`[${msg.type()}] ${text}`);
    // Google Fonts may be unreachable in a sandbox; that is not an app error.
    if (/fonts\.(googleapis|gstatic)\.com|net::ERR_/.test(text)) return;
    if (isProblem(msg.type(), text)) problems.push(`[console.${msg.type()}] ${text}`);
  });
  page.on('pageerror', (err) => problems.push(`[pageerror] ${err.stack || err.message}`));
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (!/fonts\.(googleapis|gstatic)\.com/.test(u)) problems.push(`[requestfailed] ${u} ${req.failure()?.errorText}`);
  });
  return { browser, context, page, logs, problems };
}

/** Wait until the app reports `n` more rendered frames (requires ?debug hooks). */
export async function waitFrames(page, n = 3, timeout = 120000) {
  await page.waitForFunction(() => !!window.__icarus?.ready, null, { timeout });
  const start = await page.evaluate(() => window.__icarus.frame);
  await page.waitForFunction((t) => window.__icarus.frame >= t, start + n, { timeout, polling: 50 });
}

export async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

export function report(problems, label = '') {
  if (problems.length) {
    console.error(`\n✗ ${problems.length} console problem(s) ${label}`);
    for (const p of problems.slice(0, 40)) console.error('  ' + p.slice(0, 2000));
    return false;
  }
  console.log(`✓ no console errors ${label}`);
  return true;
}
