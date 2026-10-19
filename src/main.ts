import { detectCapabilities } from './render/capabilities.ts';
import { App } from './app.ts';
import { UI } from './ui/ui.ts';
import { prefs } from './ui/prefs.ts';
import { loadKeyboardLayout } from './input/controls.ts';
import './ui/styles.css';

const boot = document.getElementById('boot')!;
const bootMsg = document.getElementById('boot-msg')!;
const uiRoot = document.getElementById('ui')!;

let failed = false;
function fatal(title: string, body: string, detail = ''): void {
  // the loading screen's backdrop becomes the backdrop of the message
  failed = true;
  uiRoot.innerHTML = '';
  boot.classList.remove('gone');
  boot.innerHTML = `<div class="fatal glass" role="alert"><h1>${title}</h1>${body}${detail ? `<p><code>${escapeHtml(detail)}</code></p>` : ''}</div>`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

async function start(): Promise<void> {
  const caps = detectCapabilities();
  if (!caps.webgl2) {
    fatal(
      'WebGL2 required',
      `<p>Icarus renders its fjords, sky and sea on the GPU and needs WebGL2, which this browser or device does not provide.</p>
       <p>Try a current Chrome, Edge, Firefox or Safari, and check that hardware acceleration is turned on.</p>`,
    );
    return;
  }
  // fonts are used by the canvas HUD; do not wait long for them (offline still works with fallbacks)
  bootMsg.textContent = 'Raising the mountains…';
  await Promise.race([
    Promise.all([document.fonts.load('600 16px "Barlow Condensed"'), document.fonts.load('400 14px "Barlow"')]).catch(() => undefined),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  await loadKeyboardLayout();
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  let app: App;
  try {
    app = new App(canvas, caps, prefs.quality);
  } catch (e) {
    fatal('Could not start the renderer', '<p>The graphics device refused to set up the scene.</p>', String((e as Error)?.message ?? e));
    return;
  }
  (window as unknown as { app: App }).app = app;
  // shader problems surface as a clear message instead of a black screen
  app.world.renderer.debug.onShaderError = (gl, _program, vs, fs) => {
    const log = (gl.getShaderInfoLog(vs) || '') + (gl.getShaderInfoLog(fs) || '');
    console.error('Shader error', log);
    fatal('A shader failed to compile', '<p>Your GPU driver rejected one of the procedural shaders. Updating the browser or graphics driver usually helps.</p>', log.slice(0, 400));
  };
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fatal('Graphics context lost', '<p>The GPU was reset (a driver update, sleep, or another tab using a lot of memory). Restoring…</p>');
  });
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  Object.assign(app.settings, { model: prefs.model, volume: prefs.volume, clouds: prefs.clouds, windFrom: prefs.windFrom, windSpeed: prefs.windSpeed });
  app.mapVisible = prefs.minimap;
  const q = new URLSearchParams(location.search);
  if (!q.has('t')) app.settings.timeOfDay = { dawn: 5.85, day: 12, golden: 16.55, dusk: 18.15, night: 22.6 }[prefs.time];
  if (q.get('model')) app.settings.model = q.get('model') as typeof prefs.model;
  app.applySettings();
  const ui = q.has('noui') ? null : new UI(uiRoot, app);
  bootMsg.textContent = 'Filling the fjord…';
  app.boot(ui);
  if (!caps.floatTargets) ui?.toast('Reduced graphics <i>·</i> no float render targets');
  // drop the loading screen once real frames are on screen
  const wait = () => {
    if (failed) return;
    if (app.frames > 3) boot.classList.add('gone');
    else requestAnimationFrame(wait);
  };
  wait();
}

void start();
