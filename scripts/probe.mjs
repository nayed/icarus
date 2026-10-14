// Prints WebGL capabilities of the headless browser for each GPU backend.
import { startServer, launch, report, shot } from './harness.mjs';

const server = await startServer();
for (const gpu of (process.argv[2] ?? 'swiftshader,egl,vulkan').split(',')) {
  const { browser, page, problems, logs } = await launch({ gpu });
  try {
    await page.goto(server.url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__probe, null, { timeout: 30000 });
    const info = await page.evaluate(() => window.__probe);
    const t0 = Date.now();
    await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n < 30 ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }));
    console.log(gpu, JSON.stringify(info), `30 frames in ${Date.now() - t0} ms`);
    await shot(page, `probe-${gpu}`);
    report(problems, gpu);
  } catch (e) {
    console.log(gpu, 'FAILED', e.message.split('\n')[0]);
    console.log(logs.slice(-5).join('\n'));
  }
  await browser.close();
}
await server.close();
