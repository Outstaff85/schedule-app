// The frame follows the document between the model's answers: the scanner lab's
// tracker (/scan-lab/track.js — pyramidal Lucas–Kanade on a small gray copy), one
// copy for the lab and the app, loaded once as a plain script.
import type { Pt } from './engine';

export type TrackStep = { pts: Pt[]; apply: (q: Pt[]) => Pt[]; moved: number; points: number };
export type Tracker = {
  reset(): void;
  step(video: HTMLVideoElement, quad: Pt[]): Promise<TrackStep | null>;
  since(t0: number, pts: Pt[]): Pt[];
};

let loading: Promise<Tracker> | null = null;
export function loadTracker(): Promise<Tracker> {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const w = window as unknown as { Track?: Tracker };
    if (w.Track) { resolve(w.Track); return; }
    const s = document.createElement('script');
    s.src = '/scan-lab/track.js';
    s.onload = () => { if (w.Track) resolve(w.Track); else { loading = null; reject(new Error('track.js gave no Track')); } };
    s.onerror = () => { loading = null; reject(new Error('track.js failed to load')); };
    document.head.appendChild(s);
  });
  return loading;
}
