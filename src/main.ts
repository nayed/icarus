import { detectCapabilities } from './render/capabilities.ts';
import { App } from './app.ts';
import './ui/styles.css';

const caps = detectCapabilities();
const canvas = document.getElementById('scene') as HTMLCanvasElement;
if (!caps.webgl2) {
  document.getElementById('ui')!.innerHTML = `
    <div class="fatal glass"><h1>Icarus needs WebGL2</h1>
    <p>This browser or GPU does not provide WebGL2, which the flight simulator requires.
    Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.</p></div>`;
} else {
  const app = new App(canvas, caps);
  (window as unknown as { app: App }).app = app;
}
