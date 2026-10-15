// Keyboard → pilot input. Bindings use KeyboardEvent.code (physical keys) so AZERTY/QWERTZ work;
// labels for the help screen come from navigator.keyboard.getLayoutMap() when available.
import type { PilotInput } from '../sim/aircraft.ts';

export type Action =
  | 'pitchDown' | 'pitchUp' | 'rollLeft' | 'rollRight' | 'yawLeft' | 'yawRight'
  | 'throttleUp' | 'throttleDown' | 'brake' | 'gear' | 'flapsDown' | 'flapsUp' | 'trimDown' | 'trimUp'
  | 'camera' | 'camChase' | 'camCockpit' | 'camCinematic' | 'light' | 'pause' | 'hud' | 'fullscreen' | 'restart';

export const BINDINGS: Record<Action, string[]> = {
  pitchDown: ['KeyW', 'ArrowUp'],
  pitchUp: ['KeyS', 'ArrowDown'],
  rollLeft: ['KeyA', 'ArrowLeft'],
  rollRight: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttleUp: ['KeyR'],
  throttleDown: ['KeyF'],
  brake: ['Space'],
  gear: ['KeyG'],
  flapsDown: ['KeyX'],
  flapsUp: ['KeyZ'],
  trimDown: ['KeyT'],
  trimUp: ['KeyY'],
  camera: ['KeyC'],
  camChase: ['Digit1'],
  camCockpit: ['Digit2'],
  camCinematic: ['Digit3'],
  light: ['KeyL'],
  pause: ['Escape', 'KeyP'],
  hud: ['KeyH'],
  fullscreen: ['KeyK'],
  restart: ['Backspace'],
};

const CODE_TO_ACTIONS = new Map<string, Action[]>();
for (const [a, codes] of Object.entries(BINDINGS) as [Action, string[]][]) {
  for (const c of codes) CODE_TO_ACTIONS.set(c, [...(CODE_TO_ACTIONS.get(c) ?? []), a]);
}

let layout: Map<string, string> | null = null;
export async function loadKeyboardLayout(): Promise<void> {
  const kb = (navigator as unknown as { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
  if (!kb?.getLayoutMap) return;
  try {
    layout = await kb.getLayoutMap();
  } catch {
    layout = null;
  }
}

const SPECIAL: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Escape: 'Esc', Backspace: '⌫',
};
export function keyLabel(code: string): string {
  if (SPECIAL[code]) return SPECIAL[code];
  const l = layout?.get(code);
  if (l) return l.toUpperCase();
  return code.replace(/^Key/, '').replace(/^Digit/, '');
}
export function actionLabel(a: Action): string {
  return BINDINGS[a].map(keyLabel).join(' / ');
}

type Listener = (a: Action) => void;

/** Holds key state and produces smoothed axes. */
export class Controls {
  readonly input: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, flapNotch: 0, gearDown: true, trim: 0 };
  private held = new Set<Action>();
  private listeners: Listener[] = [];
  enabled = true;
  /** axis response: higher = snappier */
  responsiveness = 1;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => this.onKey(e, true));
    target.addEventListener('keyup', (e) => this.onKey(e, false));
    target.addEventListener('blur', () => this.held.clear());
  }

  onAction(fn: Listener): void {
    this.listeners.push(fn);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const acts = CODE_TO_ACTIONS.get(e.code);
    if (!acts) return;
    // keep the page from scrolling / the browser from acting on our keys
    if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Backspace') e.preventDefault();
    for (const a of acts) {
      if (down) {
        if (this.held.has(a)) continue;
        this.held.add(a);
        for (const l of this.listeners) l(a);
        if (!this.enabled) continue;
        if (a === 'gear') this.input.gearDown = !this.input.gearDown;
        if (a === 'flapsDown') this.input.flapNotch = Math.min(3, this.input.flapNotch + 1);
        if (a === 'flapsUp') this.input.flapNotch = Math.max(0, this.input.flapNotch - 1);
      } else {
        this.held.delete(a);
      }
    }
  }

  isHeld(a: Action): boolean {
    return this.enabled && this.held.has(a);
  }

  /** Programmatic press (tests, on-screen buttons). */
  press(a: Action, down: boolean): void {
    const code = BINDINGS[a][0];
    this.onKey(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }), down);
  }

  update(dt: number): void {
    const inp = this.input;
    const r = this.responsiveness;
    const axis = (cur: number, neg: Action, pos: Action, rate: number, back: number) => {
      const target = (this.isHeld(pos) ? 1 : 0) - (this.isHeld(neg) ? 1 : 0);
      const rr = target === 0 ? back : Math.sign(target) !== Math.sign(cur) && cur !== 0 ? back + rate : rate;
      const d = target - cur;
      return cur + Math.sign(d) * Math.min(Math.abs(d), rr * r * dt);
    };
    inp.pitch = axis(inp.pitch, 'pitchDown', 'pitchUp', 1.6, 3.5);
    inp.roll = axis(inp.roll, 'rollLeft', 'rollRight', 2.6, 4.5);
    inp.yaw = axis(inp.yaw, 'yawLeft', 'yawRight', 2.2, 3.5);
    if (this.isHeld('throttleUp')) inp.throttle = Math.min(1, inp.throttle + 0.55 * dt);
    if (this.isHeld('throttleDown')) inp.throttle = Math.max(0, inp.throttle - 0.55 * dt);
    if (this.isHeld('trimUp')) inp.trim = Math.min(1, inp.trim + 0.3 * dt);
    if (this.isHeld('trimDown')) inp.trim = Math.max(-1, inp.trim - 0.3 * dt);
    inp.brake = this.isHeld('brake') ? Math.min(1, inp.brake + 4 * dt) : Math.max(0, inp.brake - 6 * dt);
  }

  reset(throttle = 0, gearDown = true, flapNotch = 0): void {
    Object.assign(this.input, { pitch: 0, roll: 0, yaw: 0, throttle, brake: 0, flapNotch, gearDown, trim: 0 });
  }
}
