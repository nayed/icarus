// The ring run's circuits, beside the main menu: a grid of square tiles, each a chart of its course
// (the map image, the gates, the first one ringed; a mail run's strips, the one to land on in the
// accent) under its name and par. On a phone the pane covers the menu instead, with a Back button.
import type { App } from '../app.ts';
import { COURSES, buildCourse, parFor, stripIndex, type CourseId } from '../game/course.ts';
import { STRIPS } from '../world/params.ts';
import { formatTime } from '../game/grading.ts';
import { drawGates, drawStrips, drawTerrain, label, type ChartView } from './chart.ts';
import { MUTED } from './palette.ts';

/** room around a course on its tile (m) */
const PAD = 900;

export function parLabel(id: CourseId): string {
  return formatTime(parFor(id)).replace(/\.00$/, '');
}

export class CoursePane {
  private readonly grid: HTMLElement;
  private readonly note: HTMLElement;
  private waiting = 0;

  constructor(private readonly el: HTMLElement, private readonly app: App) {
    this.grid = el.querySelector('[data-course-grid]') as HTMLElement;
    this.note = el.querySelector('[data-course-note]') as HTMLElement;
    this.grid.innerHTML = COURSES.map(
      (c) => `<button type="button" class="course-card" data-course="${c.id}" aria-pressed="false"><canvas aria-hidden="true"></canvas><span class="cap"><span class="t">${c.name}</span><span class="d">${buildCourse(c.id).length} gates${c.mail ? ' + landing' : ''} · par ${parLabel(c.id)}</span></span></button>`,
    ).join('');
  }

  /** Marks the chosen circuit and shows its description. */
  select(id: CourseId): void {
    for (const b of this.grid.querySelectorAll<HTMLElement>('[data-course]')) {
      b.classList.toggle('on', b.dataset.course === id);
      b.setAttribute('aria-pressed', String(b.dataset.course === id));
    }
    this.note.textContent = (COURSES.find((c) => c.id === id) ?? COURSES[0]).blurb;
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
    if (on) this.draw();
    else cancelAnimationFrame(this.waiting);
  }

  /** Draws every tile's chart, again once the map image is ready (a second or so after the start). */
  draw(): void {
    cancelAnimationFrame(this.waiting);
    const map = this.app.world.map;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const cv of this.grid.querySelectorAll<HTMLCanvasElement>('canvas')) {
      const id = (cv.parentElement as HTMLElement).dataset.course as CourseId;
      const w = Math.max(1, cv.clientWidth);
      const h = Math.max(1, cv.clientHeight);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const c = cv.getContext('2d') as CanvasRenderingContext2D;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = '#0b1219';
      c.fillRect(0, 0, w, h);
      if (!map.image) {
        label(c, 'CHARTING…', w / 2, h / 2 - 16, 12, MUTED);
        continue;
      }
      const gates = buildCourse(id);
      const mail = COURSES.find((c) => c.id === id)?.mail;
      const ends = mail ? [STRIPS[stripIndex(mail.from)], STRIPS[stripIndex(mail.to)]] : [];
      const xs = [...gates.map((g) => g.x), ...ends.map((s) => s.center[0])];
      const zs = [...gates.map((g) => g.z), ...ends.map((s) => s.center[1])];
      const [x0, x1, z0, z1] = [Math.min(...xs) - PAD, Math.max(...xs) + PAD, Math.min(...zs) - PAD, Math.max(...zs) + PAD];
      // north up, the course in the middle of the space above the caption (the bottom third)
      const v: ChartView = { sx: w / 2, sy: h * 0.36, wx: (x0 + x1) / 2, wz: (z0 + z1) / 2, scale: Math.min(w / (x1 - x0), (h * 0.64) / (z1 - z0)), up: 0 };
      c.imageSmoothingQuality = 'high';
      drawTerrain(c, map, v);
      if (mail) drawStrips(c, v, stripIndex(mail.to));
      drawGates(c, v, gates, gates.map((_, i) => (i === 0 ? 1 : 0)));
    }
    if (!map.image && this.visible) this.waiting = requestAnimationFrame(() => this.draw());
  }
}
