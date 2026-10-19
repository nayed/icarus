// The player's choices, kept in local storage. One shared object: the menu, the pause screen and the
// app (in-flight toggles) all read and change it, then call savePrefs().
import type { StartPoint } from '../app.ts';
import type { FlightModel } from '../sim/aircraft.ts';
import type { QualityName } from '../render/quality.ts';
import type { TimePreset } from '../world/celestial.ts';

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
  /** the HUD's moving map */
  minimap: boolean;
}

const DEFAULTS: Prefs = { mode: 'free', start: 'runway', time: 'dusk', model: 'assisted', quality: 'medium', volume: 0.7, clouds: 0.45, windFrom: 40, windSpeed: 4, minimap: true };
const KEY = 'icarus.prefs.v1';

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // storage can be unavailable (private mode, blocked site data)
  }
  return { ...DEFAULTS };
}

export const prefs: Prefs = load();

export function savePrefs(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
