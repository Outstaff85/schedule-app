"""Flat pages for the scenes (docs/scan-training.md → "Scenes: one camera for the table and the documents"): every page a
scene can lay, flat and upright, with what is printed on it known.

  Page(rgba, size_mm, doctype, kind, material, fields, mrz_text, face_box, source, rect, ppm, template_sha1, seen)

- rgba: the picture (PIL RGBA; outside a card's rounded corners alpha 0); rect: the document's own part of it in
  pixels (a passport's data page under the booklet's other page), size_mm its size; ppm: pixels per millimetre.
- fields: [(role, text, quad)] — each value's four corners in the picture's pixels (pixel edges, its top-left first,
  clockwise); a bow of the paper moves them with it. role: what the value is (surname, idNo, dob, expiry…: a marked
  real page's by hemodel.role_of — a date's "same"); kinds: each field's marked kind (template_fields.json: date,
  hedate, digits…) when it differs, else None (the drawn pages: the role is the kind). mrz_text: a passport's two zone lines; face_box the holder's
  photo's quad (or None).
- doctype: the page kind (gen.common.DOCTYPES, by gen.common.label); kind: the source's own kind (id_front, insert,
  licence, contract, form101, he_sheet…); material: card, paper or booklet.
- source: drawn (synth_docs.DRAW, synth_pages.contract / he_sheet), template (a real page whose fields are marked,
  template_vary.vary: every value made up), washed (a real page with no fields marked: its data washed out, no field
  boxes), pdf (the Form 101 template from functions/assets and the firm's contract PDFs in <home>/contracts/, rendered
  by PyMuPDF; their fields are empty).
- seen: the values come from the training vocabulary (False: the check vocabulary, the exam's — synth.vocab).

PyMuPDF is imported only when a PDF page is asked for: without it the PDF source is skipped and counted
(SKIPPED["pdf"]), the caller draws another source. Pure: no torch, no Google package."""
import functools
import pathlib
from dataclasses import dataclass, field

import numpy as np

from . import common as gc

PX = 10                      # synth_docs.PX: pixels per millimetre of the drawn documents
A4 = (210.0, 297.0)
SKIPPED = {"pdf": 0}         # PDF pages asked for while PyMuPDF is missing
PDF_DPI = (100, 125, 150)    # a PDF page is rendered at one of these (cached per process)


@dataclass
class Page:
    rgba: object
    size_mm: tuple
    doctype: str
    kind: str
    material: str
    fields: list = field(default_factory=list)
    mrz_text: object = None
    face_box: object = None
    source: str = "drawn"
    rect: tuple = None
    ppm: float = PX
    template_sha1: object = None   # a real page's content sha1 (what heldout.json keeps); None for a drawn page or a PDF
    seen: bool = True
    file_sha1: object = None       # a PDF's sha1 (the page it was rendered from)
    kinds: list = None             # each field's marked kind (a real page's), parallel to fields; None: the role is the kind

    @property
    def size_px(self):
        return self.rgba.size

    def quad(self):
        """The document's own corners in the picture (pixel edges), its top-left first, clockwise."""
        x0, y0, x1, y1 = self.rect
        return [[float(x0), float(y0)], [float(x1), float(y0)], [float(x1), float(y1)], [float(x0), float(y1)]]


def as_quad(box):
    """A field's box: (x, y, w, h) → its four corners; four corners stay as they are."""
    if len(box) == 4 and not isinstance(box[0], (list, tuple)):
        x, y, w, h = box
        return [[float(x), float(y)], [float(x + w), float(y)], [float(x + w), float(y + h)], [float(x), float(y + h)]]
    return [[float(a), float(b)] for a, b in box]


def _page(drawn, doctype, kind, material, source, ppm=PX, sha1=None, seen=True):
    im, rect = drawn
    fields = [(r, t, as_quad(b)) for r, t, b in getattr(drawn, "fields", [])]
    face = getattr(drawn, "face", None)
    mrz = getattr(drawn, "mrz", None)
    x0, y0, x1, y1 = rect
    return Page(im.convert("RGBA"), ((x1 - x0) / ppm, (y1 - y0) / ppm), doctype, kind, material, fields,
                "\n".join(mrz) if mrz else None, as_quad(face) if face else None, source, tuple(rect), ppm, sha1, seen)


MATERIAL = {"id_front": "card", "id_back": "card", "licence": "card", "passport": "booklet"}


def drawn(rng, F, kind, held=False):
    """A drawn page of a kind (synth_docs.DRAW, or synth_pages' contract / he_sheet)."""
    import synth_docs as sd
    import synth_pages as sp
    if kind == "contract":
        im = sp.contract(rng, F)
        d = sd.Drawn(im.convert("RGBA"), (0, 0, im.size[0], im.size[1]))
        return _page(d, "contract", "contract", "paper", "drawn", ppm=im.size[0] / A4[0], seen=not held)
    if kind == "he_sheet":
        d = sp.he_sheet(rng, F, held)
        return _page(d, "other", "he_sheet", "paper", "drawn", ppm=d[0].size[0] / A4[0], seen=not held)
    d = sd.DRAW[kind](rng, F, held=held, **({"fit": True} if kind == "passport" else {}))   # the zone on the page
    return _page(d, gc.label("drawn", kind), kind, MATERIAL.get(kind, "paper"), "drawn", seen=not held)


def _rot90(pt, w):
    """A point (pixel edges) of a picture w wide after PIL's rotate(90, expand=True) (a quarter turn to the left)."""
    return [pt[1], w - pt[0]]


def real(rng, F, path, kind, held=False, sharp=False):
    """A real page (templates/<kind>/…): its fields made up when they are marked (template_vary.vary, held: the check
    vocabulary) — source "template" — else its data washed out (synth_docs.washed) — source "washed", no field boxes.
    At the drawn documents' scale; a card's corners rounded; paper with folded()'s fold and bow."""
    import cv2
    from PIL import Image
    import synth_docs as sd
    import template_vary
    from hemodel import role_of
    spec = template_vary.spec_for(path)
    marked = bool(spec and spec.get("fields"))
    kinds = None
    if marked:
        im, out = template_vary.vary(rng, F.hebrew, path, spec, held=held)   # one per spec["fields"], in order
        fields = [(role_of(f), t, as_quad(b)) for f, (k, t, b) in zip(spec["fields"], out)]
        kinds = [k for k, _, _ in out]
    else:
        im = Image.fromarray(cv2.cvtColor(template_vary.load_page(path, spec), cv2.COLOR_BGR2RGB))
        fields = []
    w, h = im.size
    if w < h and kind in sd.WIDTH:
        im = im.rotate(90, expand=True)
        fields = [(k, t, [_rot90(p, w) for p in q]) for k, t, q in fields]   # each still from its text's own top-left
        w, h = im.size
    tw = int(sd.WIDTH.get(kind, rng.uniform(140, 200)) * PX)
    th = max(8, round(h * tw / w))
    sx, sy = tw / w, th / h
    im = im.resize((tw, th), Image.LANCZOS)
    fields = [(k, t, [[x * sx, y * sy] for x, y in q]) for k, t, q in fields]
    if not sharp and not marked:
        im = sd.washed(rng, F, im, kind)
    a = np.asarray(im.convert("RGB")).astype(np.float32) * np.array([rng.uniform(0.9, 1.1) for _ in range(3)], np.float32)
    im = Image.fromarray(np.clip(a + rng.uniform(-12, 12), 0, 255).astype(np.uint8))
    if kind in sd.CARDS:
        im = sd.rounded(im, 3 * PX)
        material = "card"
    elif kind in ("sefach", "insert", "contract", "other"):
        bow = {}
        im = sd.folded(rng, im, bow).convert("RGBA")
        fields = [(k, t, sd.unbow(bow, q)) for k, t, q in fields]
        material = "paper"
    else:
        im = im.convert("RGBA")
        material = MATERIAL.get(kind, "paper")
    page = Page(im, (tw / PX, th / PX), gc.label("template", kind), kind, material, fields, None, None,
                "template" if marked else "washed", (0, 0, tw, th), PX, gc.file_sha1(path), not held, kinds=kinds)
    return page


# ---------- PDFs (PyMuPDF) ----------
def _fitz():
    try:
        import pymupdf as fitz
        return fitz
    except ImportError:
        try:
            import fitz
            return fitz
        except ImportError:
            return None


def has_pdf():
    return _fitz() is not None


@functools.lru_cache(maxsize=16)
def _render(path, page_no, dpi):
    fitz = _fitz()
    with fitz.open(path) as doc:
        pg = doc[page_no % doc.page_count]
        pix = pg.get_pixmap(dpi=dpi, alpha=False)
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3].copy()
        return img, float(pg.rect.width) / 72 * 25.4, float(pg.rect.height) / 72 * 25.4


def pdf_pages(path):
    fitz = _fitz()
    if fitz is None:
        return 0
    with fitz.open(path) as doc:
        return doc.page_count


def pdf(rng, path, kind):
    """A page of a PDF (kind "form101": the Form 101 template, "other"; "contract": a firm's contract template) rendered
    at 100–150 dpi, its fields empty. None (and SKIPPED["pdf"] counted) when PyMuPDF is missing or the file unreadable."""
    from PIL import Image
    if _fitz() is None:
        SKIPPED["pdf"] += 1
        return None
    try:
        n = pdf_pages(str(path))
        img, wmm, hmm = _render(str(path), rng.randrange(max(1, n)), rng.choice(PDF_DPI))
    except Exception:
        SKIPPED["pdf"] += 1
        return None
    im = Image.fromarray(img).convert("RGBA")
    ppm = im.size[0] / wmm
    return Page(im, (wmm, hmm), gc.label("pdf", kind), kind, "paper", [], None, None, "pdf",
                (0, 0, im.size[0], im.size[1]), ppm, None, True, gc.file_sha1(path))


def pdf_sources(work):
    """[(path, kind)]: the Form 101 template (functions/assets) and the firm's contract PDFs (<home>/contracts/)."""
    out = []
    form = gc.HERE.parents[1] / "functions" / "assets" / "form101_fillable.pdf"
    if form.exists():
        out.append((str(form), "form101"))
    folder = pathlib.Path(work) / "contracts"
    if folder.is_dir():
        out += [(str(p), "contract") for p in sorted(folder.glob("*.pdf"))]
    return out


# ---------- choosing a page ----------
# The page kinds a scene lays (gen/scene.py), by weight, and how each kind is drawn.
KIND_WEIGHTS = {"id_front": 0.18, "id_back": 0.12, "passport": 0.18, "sefach": 0.16, "insert": 0.06, "contract": 0.15,
                "other": 0.15}
TEMPLATE_SHARE, PDF_SHARE = 0.4, 0.5
CARD_KINDS, SHEET_KINDS = ("id_front", "id_back"), ("sefach", "insert")


class Pool:
    """Where pages come from for one run: the real pages (templates/, already filtered to the run's side), the PDFs
    and whether values come from the check vocabulary (held: an exam run)."""

    def __init__(self, templates=(), pdfs=(), held=False, sharp=False, template_share=TEMPLATE_SHARE, pdf_share=PDF_SHARE,
                 kind_weights=None):
        self.templates, self.pdfs, self.held, self.sharp = list(templates), list(pdfs), held, sharp
        self.kind_weights = dict(kind_weights) if kind_weights else KIND_WEIGHTS   # gen mine's focus, else the defaults
        self.template_share, self.pdf_share = template_share, pdf_share
        self.by_doctype = {}
        for p, k in self.templates:
            self.by_doctype.setdefault(gc.label("template", k), []).append((p, k))

    def page(self, rng, F, kind):
        """A page of a kind (a key of KIND_WEIGHTS, or a card / sheet kind): a real page, a PDF page or a drawn one."""
        doctype = "other" if kind == "insert" else kind
        reals = [pk for pk in self.by_doctype.get(doctype, []) if kind != "insert" or pk[1] in ("insert", "licence", "other")]
        if reals and rng.random() < self.template_share:
            path, k = rng.choice(reals)
            return real(rng, F, path, k, self.held, self.sharp)
        if kind in ("contract", "other"):
            pdfs = [pk for pk in self.pdfs if gc.label("pdf", pk[1]) == kind]
            if pdfs and rng.random() < self.pdf_share:
                got = pdf(rng, *rng.choice(pdfs))
                if got is not None:
                    return got
            if kind == "other":
                return drawn(rng, F, "he_sheet" if rng.random() < 0.6 else "insert", self.held)
        return drawn(rng, F, kind, self.held)

    def any(self, rng, F, kinds=None):
        names = [k for k in KIND_WEIGHTS if not kinds or k in kinds]
        return self.page(rng, F, rng.choices(names, [self.kind_weights.get(k, KIND_WEIGHTS[k]) for k in names])[0])
