// The shutter: a camera's click and a short buzz the moment a shot is taken — the session's status "captured"
// (engine/shot.ts takeShot, the frame grabbed), so the site's scanner and the lab alike, the shutter tapped or Auto;
// a picked file is not a shot and makes no sound (owner, 2026-10-26).
//
// The click is drawn with Web Audio — a burst of noise through a band-pass, falling off in ~70 ms, and a softer second
// one, as a phone's camera sounds — so there is no sound file to load. A browser starts audio only from a person's
// gesture (iOS above all): the first tap on the scanner's screen unlocks it (unlockShutter), and an Auto shot after it
// is heard too. With no Web Audio, or audio not unlocked yet, only the buzz (where the phone has one); never an error.
// `shutterCount` counts the shots sounded; the page's <html data-shutters> shows it (the browser test reads it).

type AudioCtx = AudioContext;

let ctx: AudioCtx | null = null;
let noise: AudioBuffer | null = null;
export let shutterCount = 0;

function audio(): AudioCtx | null {
  if (ctx) return ctx;
  const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const C = W.AudioContext || W.webkitAudioContext;
  if (!C) return null;
  try { ctx = new C(); } catch { ctx = null; }
  return ctx;
}

/** On a person's gesture: the audio is started (resumed), so a shot later is heard. */
export function unlockShutter(): void {
  const a = audio();
  if (a && a.state === 'suspended') void a.resume().catch(() => {});
}

function burst(a: AudioCtx, at: number, gain: number, hz: number): void {
  if (!noise) {
    noise = a.createBuffer(1, Math.round(a.sampleRate * 0.08), a.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = a.createBufferSource();
  src.buffer = noise;
  const band = a.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = hz;
  band.Q.value = 0.9;
  const env = a.createGain();
  env.gain.setValueAtTime(gain, at);
  env.gain.exponentialRampToValueAtTime(0.001, at + 0.07);
  src.connect(band).connect(env).connect(a.destination);
  src.start(at);
  src.stop(at + 0.08);
}

/** The shot's click and buzz. */
export function playShutter(): void {
  shutterCount++;
  document.documentElement.dataset.shutters = String(shutterCount);
  try { if (navigator.vibrate) navigator.vibrate(30); } catch { /* no buzz here */ }
  const a = audio();
  if (!a || a.state !== 'running') return;
  try {
    const t = a.currentTime;
    burst(a, t, 0.6, 2400);
    burst(a, t + 0.09, 0.35, 1800);
  } catch { /* the sound is a nicety: never a failed shot */ }
}
