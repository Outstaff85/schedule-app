// The scanner's engine (docs/scan-plan.md → S9): the shapes its pure modules share.
// A point is in shares of the picture (0..1) unless a function says pixels.

/** A point [x, y]. */
export type Pt = [number, number];
/** A document's frame: four points, top-left, top-right, bottom-right, bottom-left. */
export type Quad = Pt[];
/** The corners model's answer: a corner it could not find is null; conf is the weakest corner's peak. */
export interface Corners { pts: (Pt | null)[]; conf: number }
/** A frame every corner of which was found. */
export interface FoundCorners { pts: Quad; conf: number }

/** Pixels as an ImageData (RGBA, 4 bytes a pixel), without the DOM. */
export interface PixelsLike { data: ArrayLike<number>; width: number; height: number }
/** A warped picture (warpRGBA). */
export interface Rgba { data: Uint8ClampedArray; width: number; height: number }

/** A heatmap's spot: its centre (shares) and its peak. */
export interface Spot { p: Pt; v: number }

/** One level of a gray pyramid (track.ts). */
export interface GrayLevel { img: Float32Array; w: number; h: number }
export type Pyramid = GrayLevel[];
/** A least-squares affine map in pixels: [a, b, c, d, e, f] — x' = a·x + b·y + c, y' = d·x + e·y + f. */
export type Affine = number[];

/** Key–value storage as localStorage (fails.ts). */
export interface KeyValue { getItem(key: string): string | null; setItem(key: string, value: string): void }
