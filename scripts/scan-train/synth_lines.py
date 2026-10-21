"""Draws made-up text lines (synth.py) as pictures for the scanner's text readers (docs/hf-plan.md →
H8b, H8c; docs/scan-training.md → 6) with TRDG (TextRecognitionDataGenerator, MIT): each line in a
font of the kind, tilted, blurred and on a varied background a little, with its text beside it.
Run on the owner's PC before a reader's training — nothing is uploaded: the same seed draws the
same lines again, so only this script is kept.

  python synth_lines.py mrz --count 100000                    # → ~/.scan-train/synth/mrz/
  python synth_lines.py he --count 50000 --fonts C:/Windows/Fonts/arial.ttf C:/Windows/Fonts/david.ttf

Writes <out>/<kind>/<n>.png and <out>/<kind>/labels.tsv (file, text — Hebrew in logical order).
The passport zone's font is OCR-B (fonts/OCRB.otf: Matthew Skala's, public domain); the Hebrew
fonts are the PC's own (Windows: Arial, David, Miriam, Narkisim — whichever are there).
Needs: pip install -r requirements-synth.txt."""
import argparse
import os
import pathlib
import random

from synth import lines

HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path.home() / ".scan-train" / "synth"
MRZ_FONTS = [HERE / "fonts" / "OCRB.otf"]
WIN_HE = ("arial.ttf", "arialbd.ttf", "david.ttf", "davidbd.ttf", "mriam.ttf", "nrkis.ttf", "frank.ttf", "tahoma.ttf")


def _pillow_compat():
    """TRDG 1.8 measures text with ImageFont.getsize, gone since Pillow 10: the same answer from getbbox."""
    from PIL import ImageFont
    if not hasattr(ImageFont.FreeTypeFont, "getsize"):
        def getsize(self, text, *a, **k):
            left, top, right, bottom = self.getbbox(text)
            return right - left, bottom
        ImageFont.FreeTypeFont.getsize = getsize


def hebrew_fonts():
    found = [str(p) for p in (pathlib.Path("C:/Windows/Fonts") / n for n in WIN_HE) if p.exists()]
    return found or [str(p) for p in pathlib.Path("/usr/share/fonts").rglob("*.ttf") if "DejaVuSans" in p.name][:2]


def _batch(job):
    """One batch of lines, drawn with its own look (background, tilt, blur, spacing): job = (kind,
    fonts, size, seed, start, shown, texts, folder) → its label lines."""
    kind, fonts, size, seed, start, shown, texts, folder = job
    _pillow_compat()
    from trdg.generators import GeneratorFromStrings
    rng = random.Random(seed * 1_000_003 + start)
    random.seed(seed * 1_000_003 + start)   # TRDG's own choices (the tilt, the blur) too
    gen = GeneratorFromStrings(
        shown, count=len(shown), fonts=fonts, size=size,
        skewing_angle=2, random_skew=True, blur=rng.choice((0, 1, 1, 2)), random_blur=True,
        background_type=rng.choice((0, 0, 1, 1)) if kind == "mrz" else rng.choice((0, 1, 1)),
        distorsion_type=rng.choice((0, 0, 0, 3)), character_spacing=rng.choice((0, 0, 1, 2)) if kind == "mrz" else 0,
        margins=(rng.randint(2, 8), rng.randint(2, 10), rng.randint(2, 8), rng.randint(2, 10)),
        text_color="#101010,#404040", fit=rng.random() < 0.3)
    labels = []
    for j, (img, _) in enumerate(gen):
        name = f"{start + j}.png"
        img.convert("L").save(pathlib.Path(folder) / name)
        labels.append(f"{name}\t{texts[j]}")
    return labels


def draw(kind, count, out, fonts, seed=1, size=40, jobs=1):
    """count lines of a kind into out/<kind>/ with their labels, in batches of 256 on jobs processes."""
    folder = pathlib.Path(out) / kind
    folder.mkdir(parents=True, exist_ok=True)
    texts = [t for t, _ in lines(kind, count, seed)]
    if kind == "he":
        from bidi.algorithm import get_display
        shown = [get_display(t) for t in texts]   # TRDG draws left to right: the Hebrew is given in its visual order
    else:
        shown = texts
    work = [(kind, [str(f) for f in fonts], size, seed, s, shown[s:s + 256], texts[s:s + 256], str(folder)) for s in range(0, len(texts), 256)]
    if jobs > 1:
        from multiprocessing import Pool
        with Pool(jobs) as pool:
            done = pool.map(_batch, work)
    else:
        done = [_batch(w) for w in work]
    labels = [l for b in done for l in b]
    (folder / "labels.tsv").write_text("\n".join(labels) + "\n", encoding="utf-8")
    return folder, len(labels)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=("mrz", "he"))
    ap.add_argument("--count", type=int, default=100000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="processes drawing at once")
    ap.add_argument("--fonts", nargs="*", help="font files (default: OCR-B for mrz, the PC's Hebrew fonts for he)")
    a = ap.parse_args()
    fonts = a.fonts or ([str(f) for f in MRZ_FONTS] if a.kind == "mrz" else hebrew_fonts())
    if not fonts:
        raise SystemExit("no font found: give --fonts")
    folder, n = draw(a.kind, a.count, a.out, fonts, a.seed, jobs=a.jobs)
    print(f"{n} lines in {folder}")


if __name__ == "__main__":
    main()
