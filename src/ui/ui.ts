// DOM user interface: main menu, controls sheet, pause/settings overlay, results card, toasts.
import type { App, StartPoint } from '../app.ts';
import type { FlightModel } from '../sim/aircraft.ts';
import type { QualityName } from '../render/quality.ts';
import { TIME_PRESETS, type TimePreset } from '../world/celestial.ts';
import type { ModeResult } from '../game/grading.ts';
import { formatTime } from '../game/grading.ts';
import { actionLabel, keyLabel, type Action } from '../input/controls.ts';
import { buildCourse, coursePar } from '../game/course.ts';
import { toggleFullscreen } from '../app.ts';

export type MenuMode = 'free' | 'rings' | 'landing';

export interface Prefs {
  mode: MenuMode;
  start: StartPoint;
  time: TimePreset;
  model: FlightModel;
  quality: QualityName;
  volume: number;
  clouds: number;
  windFrom: number;
  windSpeed: number;
}

const DEFAULTS: Prefs = { mode: 'free', start: 'runway', time: 'dusk', model: 'assisted', quality: 'medium', volume: 0.7, clouds: 0.45, windFrom: 40, windSpeed: 4 };
const KEY = 'icarus.prefs.v1';

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // storage can be unavailable (private mode, blocked site data)
  }
  return { ...DEFAULTS };
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

const MODE_INFO: Record<MenuMode, { t: string; d: () => string }> = {
  free: { t: 'Free flight', d: () => 'No clock, no score. Take off from the strip, the water or the air.' },
  rings: { t: 'Ring run', d: () => `Fourteen gates down the fjord against the clock. Par ${formatTime(coursePar(buildCourse())).replace(/\.00$/, '')}.` },
  landing: { t: 'Mountain landing', d: () => 'A short gravel strip on a shelf 800 m up. Graded on the touchdown.' },
};
const MODEL_INFO: Record<FlightModel, string> = {
  arcade: 'Rate controls, protected stalls and speeds, forgiving touchdowns. Point and fly.',
  assisted: 'Real aerodynamics, with auto-coordination, wing levelling, and stall and overspeed protection.',
  simulation: 'Raw controls: torque, P-factor, adverse yaw and spins. Use the rudder and trim.',
};
const TIME_LABEL: Record<TimePreset, string> = { dawn: 'Dawn', day: 'Day', golden: 'Golden', dusk: 'Dusk', night: 'Night' };
const QUALITY_INFO: Record<QualityName, string> = {
  low: 'Light on the GPU: shorter view of the trees, no water reflections.',
  medium: 'Balanced. Resolution scales automatically to hold 60 fps.',
  high: 'Full detail: volumetric clouds at half resolution, mirror-calm fjords.',
};

const KEY_ROWS: [string, Action[]][] = [
  ['Pitch', ['pitchDown', 'pitchUp']],
  ['Roll', ['rollLeft', 'rollRight']],
  ['Rudder', ['yawLeft', 'yawRight']],
  ['Throttle', ['throttleUp', 'throttleDown']],
  ['Brakes', ['brake']],
  ['Flaps', ['flapsDown', 'flapsUp']],
  ['Gear', ['gear']],
  ['Trim', ['trimUp', 'trimDown']],
  ['Camera', ['camera', 'camChase', 'camCockpit', 'camCinematic']],
  ['Landing light', ['light']],
  ['HUD · fullscreen', ['hud', 'fullscreen']],
  ['Pause', ['pause']],
  ['Restart', ['restart']],
];

function hhmm(h: number): string {
  const t = ((h % 24) + 24) % 24;
  const hh = Math.floor(t);
  const mm = Math.floor((t - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function compass(deg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export class UI {
  readonly prefs: Prefs;
  private readonly menu: HTMLElement;
  private readonly controlsSheet: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly results: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly caption: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly app: App) {
    this.prefs = loadPrefs();
    root.innerHTML = `
      <section class="screen menu hidden" data-screen="menu">
        <div class="scrim"></div>
        <div class="menu-panel glass" role="dialog" aria-label="Main menu">
          <div class="menu-body">
          <h1 class="brand">ICARUS</h1>
          <div class="brand-sub">Fjord flights at the edge of night</div>
          <div class="section"><div class="label">Mode</div><div class="cards" data-group="mode"></div>
            <div class="seg sub-seg" data-group="start"></div></div>
          <div class="section"><div class="label">Time of day <span class="hint" data-hint="time"></span></div><div class="seg" data-group="time"></div></div>
          <div class="section"><div class="label">Flight model</div><div class="seg" data-group="model"></div><div class="seg-note" data-note="model"></div></div>
          <div class="section"><div class="label">Graphics</div><div class="seg" data-group="quality"></div><div class="seg-note" data-note="quality"></div></div>
          <div class="touch-note" data-touch hidden>Icarus is flown with a keyboard. On a touch screen you can enjoy the flight from the cinematic camera.</div>
          </div>
          <div class="menu-actions">
            <button class="btn primary fly" data-act="fly">Fly <span class="kbd">Enter</span></button>
            <div class="menu-foot">
              <div class="foot-links"><button class="linkish" data-act="controls">Controls</button><button class="linkish" data-act="fullscreen">Fullscreen</button></div>
              <span>Procedural · no assets</span>
            </div>
          </div>
        </div>
        <div class="controls-sheet glass hidden" data-sheet>
          <h3>Controls</h3>
          <div class="keys" data-keys></div>
          <div class="note">Keys follow your keyboard layout. Drag with the mouse to look around. The aircraft is an amphibian: gear down for the strips, gear up for the water.</div>
        </div>
        <div class="caption"><b>69.6° N</b>Late September · Northern Norway</div>
      </section>
      <section class="screen hidden" data-screen="pause">
        <div class="scrim"></div>
        <div class="modal glass" role="dialog" aria-label="Paused">
          <h2>Paused</h2>
          <div class="sub" data-pause-sub></div>
          <div class="slider"><div class="row"><span class="label">Time of day</span><span class="v" data-v="time"></span></div><input type="range" min="0" max="24" step="0.0167" data-slider="time" aria-label="Time of day"></div>
          <div class="slider"><div class="row"><span class="label">Clouds</span><span class="v" data-v="clouds"></span></div><input type="range" min="0" max="1" step="0.01" data-slider="clouds" aria-label="Cloud cover"></div>
          <div class="slider"><div class="row"><span class="label">Wind</span><span class="v" data-v="wind"></span></div><input type="range" min="0" max="15" step="0.1" data-slider="wind" aria-label="Wind speed"></div>
          <div class="slider"><div class="row"><span class="label">Wind from</span><span class="v" data-v="windFrom"></span></div><input type="range" min="0" max="359" step="1" data-slider="windFrom" aria-label="Wind direction"></div>
          <div class="slider"><div class="row"><span class="label">Volume</span><span class="v" data-v="volume"></span></div><input type="range" min="0" max="1" step="0.01" data-slider="volume" aria-label="Volume"></div>
          <div class="divider"></div>
          <div class="inline-seg"><span class="label">Flight model</span><div class="seg" data-group="pmodel"></div></div>
          <div class="inline-seg"><span class="label">Graphics</span><div class="seg" data-group="pquality"></div></div>
          <div class="divider"></div>
          <div class="btn-row">
            <button class="btn primary" data-act="resume">Resume <span class="kbd">${keyLabel('KeyP')}</span></button>
            <button class="btn" data-act="restart">Restart</button>
          </div>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn" data-act="menu">Main menu</button>
            <button class="btn" data-act="fullscreen">Fullscreen</button>
          </div>
        </div>
      </section>
      <section class="screen hidden" data-screen="results">
        <div class="scrim"></div>
        <div class="modal glass results" role="dialog" aria-label="Results" data-results></div>
      </section>
      <div class="toasts passthrough" data-toasts></div>`;
    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.menu = q('[data-screen="menu"]');
    this.controlsSheet = q('[data-sheet]');
    this.pause = q('[data-screen="pause"]');
    this.results = q('[data-screen="results"]');
    this.toasts = q('[data-toasts]');
    this.caption = q('.caption');
    if (matchMedia('(pointer: coarse)').matches) (q('[data-touch]') as HTMLElement).hidden = false;
    this.renderMenu();
    this.renderKeys();
    this.bindSliders();
    root.addEventListener('click', (e) => this.onClick(e));
    addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('fullscreenchange', () => this.syncFullscreen());
    this.syncFullscreen();
    void this.caption;
  }

  /** Fullscreen buttons (menu and pause) follow the state, and hide where fullscreen is unavailable. */
  private syncFullscreen(): void {
    const on = !!document.fullscreenElement;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-act="fullscreen"]')) {
      b.hidden = !document.fullscreenEnabled;
      b.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
      b.title = `${on ? 'Exit fullscreen' : 'Fullscreen'} (${actionLabel('fullscreen')})`;
    }
  }

  // ---------------------------------------------------------------- menu

  private seg<T extends string>(group: string, items: [T, string][], value: T): void {
    const el = this.root.querySelector(`[data-group="${group}"]`) as HTMLElement;
    el.innerHTML = items.map(([v, l]) => `<button type="button" data-${group}="${v}" class="${v === value ? 'on' : ''}" aria-pressed="${v === value}">${l}</button>`).join('');
  }

  private renderMenu(): void {
    const p = this.prefs;
    const cards = this.root.querySelector('[data-group="mode"]') as HTMLElement;
    cards.innerHTML = (Object.keys(MODE_INFO) as MenuMode[])
      .map((m) => `<button type="button" class="card ${m === p.mode ? 'on' : ''}" data-mode="${m}" aria-pressed="${m === p.mode}"><span class="t">${MODE_INFO[m].t}</span><span class="d">${MODE_INFO[m].d()}</span></button>`)
      .join('');
    this.seg('start', [['runway', 'Coastal strip'], ['water', 'On the water'], ['air', 'Airborne']], p.start);
    (this.root.querySelector('[data-group="start"]') as HTMLElement).style.display = p.mode === 'free' ? '' : 'none';
    this.seg('time', (Object.keys(TIME_PRESETS) as TimePreset[]).map((t) => [t, TIME_LABEL[t]] as [TimePreset, string]), p.time);
    (this.root.querySelector('[data-hint="time"]') as HTMLElement).textContent = hhmm(TIME_PRESETS[p.time]);
    this.seg('model', [['arcade', 'Arcade'], ['assisted', 'Assisted'], ['simulation', 'Simulation']], p.model);
    (this.root.querySelector('[data-note="model"]') as HTMLElement).textContent = MODEL_INFO[p.model];
    this.seg('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], p.quality);
    (this.root.querySelector('[data-note="quality"]') as HTMLElement).textContent = QUALITY_INFO[p.quality];
    this.seg('pmodel', [['arcade', 'Arcade'], ['assisted', 'Assisted'], ['simulation', 'Sim']], p.model);
    this.seg('pquality', [['low', 'Low'], ['medium', 'Med'], ['high', 'High']], p.quality);
  }

  private renderKeys(): void {
    const el = this.root.querySelector('[data-keys]') as HTMLElement;
    el.innerHTML = KEY_ROWS.map(([label, acts]) => {
      const keys = acts.map((a) => actionLabel(a).split(' / ').map((k) => `<span class="kbd">${k}</span>`).join(''));
      return `<span class="k">${keys.join('<span style="opacity:.4;padding:0 2px">·</span>')}</span><span>${label}</span>`;
    }).join('');
  }

  /** Re-render key labels once the keyboard layout is known. */
  refreshKeys(): void {
    this.renderKeys();
  }

  showMenu(): void {
    this.hideAll();
    this.menu.classList.remove('hidden');
    this.renderMenu();
  }

  isMenuOpen(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  // ---------------------------------------------------------------- pause

  private bindSliders(): void {
    this.root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((inp) => {
      inp.addEventListener('input', () => this.onSlider(inp));
    });
  }

  private syncSliders(): void {
    const s = this.app.settings;
    const set = (name: string, v: number, label: string) => {
      const inp = this.root.querySelector(`[data-slider="${name}"]`) as HTMLInputElement;
      inp.value = String(v);
      const min = Number(inp.min);
      const max = Number(inp.max);
      inp.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
      (this.root.querySelector(`[data-v="${name}"]`) as HTMLElement).textContent = label;
    };
    set('time', s.timeOfDay, hhmm(s.timeOfDay));
    set('clouds', s.clouds, `${Math.round(s.clouds * 100)}%`);
    set('wind', s.windSpeed, `${Math.round(s.windSpeed * 1.944)} kt`);
    set('windFrom', s.windFrom, `${String(Math.round(s.windFrom)).padStart(3, '0')}° ${compass(s.windFrom)}`);
    set('volume', s.volume, `${Math.round(s.volume * 100)}%`);
  }

  private onSlider(inp: HTMLInputElement): void {
    const s = this.app.settings;
    const v = Number(inp.value);
    const k = inp.dataset.slider;
    if (k === 'time') s.timeOfDay = v;
    else if (k === 'clouds') s.clouds = v;
    else if (k === 'wind') s.windSpeed = v;
    else if (k === 'windFrom') s.windFrom = v;
    else if (k === 'volume') s.volume = v;
    this.app.applySettings();
    Object.assign(this.prefs, { volume: s.volume, clouds: s.clouds, windFrom: s.windFrom, windSpeed: s.windSpeed });
    savePrefs(this.prefs);
    this.syncSliders();
  }

  showPause(): void {
    this.hideAll();
    const s = this.app.session;
    const title = this.app.sessionKind === 'rings' ? 'Ring run' : this.app.sessionKind === 'landing' ? 'Mountain landing' : 'Free flight';
    (this.root.querySelector('[data-pause-sub]') as HTMLElement).textContent = `${title} · ${formatTime(this.app.simTime).replace(/\.\d+$/, '')} in the air`;
    void s;
    this.syncSliders();
    this.renderMenu();
    this.pause.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- results

  showResults(r: ModeResult): void {
    this.hideAll();
    const el = this.root.querySelector('[data-results]') as HTMLElement;
    const good = r.grade === 'S' || r.grade === 'A';
    el.innerHTML = `
      <div class="label">${r.title}</div>
      <div class="top">
        <div class="grade ${good ? '' : 'dim'}">${r.grade}</div>
        <div><div class="headline">${r.headline}</div><div class="subtitle">${r.subtitle}</div></div>
      </div>
      <div class="metrics">${r.metrics
        .map((m) => `<div class="metric"><span class="ml">${m.label}${m.note ? ` <span style="color:var(--faint)">· ${m.note}</span>` : ''}</span><span class="mv">${m.value}</span><div class="bar"><i data-w="${Math.round(Math.max(0, Math.min(1, m.score)) * 100)}"></i></div></div>`)
        .join('')}</div>
      <div class="btn-row">
        <button class="btn primary" data-act="retry">Retry <span class="kbd">Enter</span></button>
        ${r.mode !== 'free' ? '<button class="btn" data-act="free">Free flight</button>' : ''}
        <button class="btn" data-act="menu">Menu</button>
      </div>`;
    this.results.classList.remove('hidden');
    requestAnimationFrame(() =>
      requestAnimationFrame(() => el.querySelectorAll<HTMLElement>('.bar i').forEach((b) => (b.style.width = `${b.dataset.w}%`))),
    );
  }

  hideAll(): void {
    for (const s of [this.menu, this.pause, this.results]) s.classList.add('hidden');
    this.controlsSheet.classList.add('hidden');
  }

  // ---------------------------------------------------------------- toasts

  toast(html: string): void {
    const t = document.createElement('div');
    t.className = 'toast glass';
    t.innerHTML = html;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    setTimeout(() => t.remove(), 2300);
  }

  // ---------------------------------------------------------------- events

  private choose(group: string, value: string): void {
    const p = this.prefs;
    if (group === 'mode') p.mode = value as MenuMode;
    else if (group === 'start') p.start = value as StartPoint;
    else if (group === 'time') {
      p.time = value as TimePreset;
      this.app.settings.timeOfDay = TIME_PRESETS[p.time];
      this.app.applySettings();
    } else if (group === 'model' || group === 'pmodel') {
      p.model = value as FlightModel;
      this.app.settings.model = p.model;
      this.app.applySettings();
      if (group === 'pmodel') this.toast(`Flight model <i>·</i> ${value}`);
    } else if (group === 'quality' || group === 'pquality') {
      p.quality = value as QualityName;
      this.app.setQuality(p.quality);
    }
    savePrefs(p);
    this.renderMenu();
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const btn = t.closest('button') as HTMLButtonElement | null;
    if (!btn) return;
    for (const g of ['mode', 'start', 'time', 'model', 'quality', 'pmodel', 'pquality']) {
      const v = btn.dataset[g];
      if (v !== undefined) {
        this.app.audio.start();
        this.app.audio.click();
        this.choose(g, v);
        return;
      }
    }
    const act = btn.dataset.act;
    if (!act) return;
    this.app.audio.start();
    this.app.audio.click();
    if (act === 'fly') this.fly();
    else if (act === 'controls') this.controlsSheet.classList.toggle('hidden');
    else if (act === 'resume') this.app.resume();
    else if (act === 'restart' || act === 'retry') this.app.restartSession();
    else if (act === 'menu') this.app.enterMenu();
    else if (act === 'free') this.app.startSession('free', 'runway');
    else if (act === 'fullscreen') void toggleFullscreen();
  }

  fly(): void {
    const p = this.prefs;
    this.app.settings.timeOfDay = TIME_PRESETS[p.time];
    this.app.settings.model = p.model;
    this.app.applySettings();
    this.app.startSession(p.mode, p.start);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (this.isMenuOpen()) {
        e.preventDefault();
        this.app.audio.start();
        this.fly();
      } else if (!this.results.classList.contains('hidden')) {
        e.preventDefault();
        this.app.restartSession();
      }
    } else if (e.code === 'Escape' && !this.results.classList.contains('hidden')) {
      this.app.enterMenu();
    } else if (e.code === 'Escape' && !this.controlsSheet.classList.contains('hidden')) {
      this.controlsSheet.classList.add('hidden');
    }
  }
}
