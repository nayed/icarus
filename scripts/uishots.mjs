// UI screenshots: menu (desktop + phone), controls sheet, in-flight HUD, pause overlay, results card.
import { startServer, launch, waitFrames, shot, report } from './harness.mjs';
const server = await startServer();
let failures = 0;
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = [];
for (const [w, h, tag] of [[1920, 1080, 'desktop'], [390, 844, 'phone']]) {
  const { browser, page, problems } = await launch({ width: w, height: h });
  all.push(problems);
  await page.goto(`${server.url}?debug&q=medium`);
  await waitFrames(page, 3, 180000);
  await page.evaluate(() => { localStorage.clear(); window.__icarus.setAutoScale(false); });
  await page.waitForFunction(() => document.getElementById('boot').classList.contains('gone'), null, { timeout: 60000 });
  await sleep(4000);
  const state = await page.evaluate(() => window.__icarus.session.state());
  check(state === 'menu', `${tag}: boots into the menu (state ${state})`);
  await shot(page, `ui-${tag}-menu`);
  if (tag === 'desktop') {
    await page.click('text=Controls');
    await sleep(500);
    await shot(page, `ui-${tag}-controls`);
    await page.click('text=Controls');
    await page.click('.card[data-mode="rings"]');
    await page.click('[data-time="night"]');
    await sleep(2500);
    await shot(page, `ui-${tag}-menu-night`);
    await page.keyboard.press('Enter');
    await sleep(800);
    check((await page.evaluate(() => window.__icarus.session.state())) === 'flying', 'Enter starts the selected mode');
    await page.keyboard.down('KeyR'); await sleep(600); await page.keyboard.up('KeyR');
    await sleep(2500);
    await shot(page, `ui-${tag}-hud-rings`);
    await page.keyboard.press('KeyC'); await sleep(1200);
    await shot(page, `ui-${tag}-hud-cockpit`);
    await page.keyboard.press('Escape');
    await sleep(600);
    check((await page.evaluate(() => window.__icarus.session.state())) === 'paused', 'Esc pauses');
    await shot(page, `ui-${tag}-pause`);
    // drag the clouds slider and check the value label follows
    const slider = await page.$('[data-slider="clouds"]');
    const box = await slider.boundingBox();
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
    await sleep(300);
    const cloudsLabel = await page.textContent('[data-v="clouds"]');
    check(/\d+%/.test(cloudsLabel) && Number(cloudsLabel.replace('%', '')) > 70, `clouds slider sets ${cloudsLabel}`);
    await page.keyboard.press('Escape');
    await sleep(400);
    check((await page.evaluate(() => window.__icarus.session.state())) === 'flying', 'Esc resumes');
    // results: a landing flown by the autopilot (fast-forwarded)
    await page.evaluate(() => { window.__icarus.setTime(18.0); window.__icarus.session.start('landing'); window.__icarus.setFixedDt(1 / 12); window.__icarus.session.autoLanding(false); });
    await page.waitForFunction(() => window.__icarus.session.state() === 'results', null, { timeout: 240000 });
    await page.evaluate(() => window.__icarus.setFixedDt(null));
    await sleep(1800);
    await shot(page, `ui-${tag}-results`);
    const grade = await page.textContent('.grade');
    check(!!grade, `results card shows grade ${grade}`);
    await page.keyboard.press('Escape');
    await sleep(800);
    check((await page.evaluate(() => window.__icarus.session.state())) === 'menu', 'Esc on results returns to the menu');
  } else {
    await page.evaluate(() => document.querySelector('.menu-body').scrollTop = 400);
    await sleep(300);
    await shot(page, `ui-${tag}-menu-scrolled`);
  }
  await browser.close();
}
const ok = all.every((p) => report(p)) && failures === 0;
console.log(ok ? 'UI OK' : `UI FAILED (${failures})`);
await server.close();
process.exit(ok ? 0 : 1);
