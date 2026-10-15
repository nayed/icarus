// Sun, moon and star field for a fixed latitude and season. Local frame: +x east, -z north, +y up.
import * as THREE from 'three';

export const LATITUDE_DEG = 69.6;
/** Late September: long twilights, properly dark nights for the aurora. */
export const SUN_DECLINATION_DEG = -2;
const MOON_DECLINATION_DEG = 8;
/** Moon is 140° east of the sun: a waxing gibbous moon up in the south-east at dusk. */
const MOON_ELONGATION_DEG = 140;

const rad = THREE.MathUtils.degToRad;
const PHI = rad(LATITUDE_DEG);
/** Celestial pole, east, and the equator point on the southern meridian. */
const POLE = new THREE.Vector3(0, Math.sin(PHI), -Math.cos(PHI));
const EAST = new THREE.Vector3(1, 0, 0);
const QEQ = new THREE.Vector3().crossVectors(EAST, POLE);

function equatorialToLocal(hourAngle: number, dec: number, out: THREE.Vector3): THREE.Vector3 {
  const cd = Math.cos(dec);
  return out
    .copy(QEQ)
    .multiplyScalar(cd * Math.cos(hourAngle))
    .addScaledVector(EAST, -cd * Math.sin(hourAngle))
    .addScaledVector(POLE, Math.sin(dec));
}

/** Local solar time in hours [0, 24). */
export function sunDirection(hours: number, out: THREE.Vector3): THREE.Vector3 {
  return equatorialToLocal(rad((hours - 12) * 15), rad(SUN_DECLINATION_DEG), out);
}

export function moonDirection(hours: number, out: THREE.Vector3): THREE.Vector3 {
  return equatorialToLocal(rad((hours - 12) * 15 - MOON_ELONGATION_DEG), rad(MOON_DECLINATION_DEG), out);
}

/** Fraction of the moon disc that is lit. */
export const MOON_ILLUMINATION = (1 - Math.cos(rad(MOON_ELONGATION_DEG))) / 2;

/** Rotation taking local directions into the (fixed) celestial frame of the star field. */
export function starRotation(hours: number, out: THREE.Matrix3): THREE.Matrix3 {
  const ha = rad((hours - 12) * 15);
  // Basis of the celestial frame expressed in local coordinates at this time.
  const q = equatorialToLocal(ha, 0, new THREE.Vector3());
  const e = equatorialToLocal(ha - Math.PI / 2, 0, new THREE.Vector3());
  // rows = basis vectors → multiplying a local vector gives celestial coordinates
  return out.set(q.x, q.y, q.z, POLE.x, POLE.y, POLE.z, e.x, e.y, e.z);
}

/** Elevation of a direction in degrees. */
export function elevationDeg(dir: THREE.Vector3): number {
  return THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)));
}

/**
 * Authored exposure curve against sun elevation (pre-exposure applied to all lighting).
 * Log-linear between keys; night is moonlit and kept readable.
 */
const EXPOSURE_KEYS: [number, number][] = [
  [-90, 9000], [-16, 9000], [-12, 3800], [-8, 1300], [-4, 230], [0, 48], [4, 19], [10, 11], [90, 9],
];
export function exposureForSun(sunElevDeg: number): number {
  for (let i = 1; i < EXPOSURE_KEYS.length; i++) {
    const [e1, v1] = EXPOSURE_KEYS[i];
    if (sunElevDeg <= e1) {
      const [e0, v0] = EXPOSURE_KEYS[i - 1];
      const t = (sunElevDeg - e0) / (e1 - e0);
      return Math.exp(Math.log(v0) + (Math.log(v1) - Math.log(v0)) * t);
    }
  }
  return EXPOSURE_KEYS[EXPOSURE_KEYS.length - 1][1];
}

/** Solar illuminance (arbitrary units) and an artistically bright moon. */
export const SUN_ILLUMINANCE = new THREE.Vector3(1.0, 0.985, 0.96);
export const MOON_ILLUMINANCE_SCALE = 3.2e-4;

export const TIME_PRESETS = {
  dawn: 5.85,
  day: 12.0,
  golden: 16.55,
  dusk: 18.15,
  night: 22.6,
} as const;
export type TimePreset = keyof typeof TIME_PRESETS;
