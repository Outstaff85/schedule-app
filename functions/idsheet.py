"""The worker's scanned pages laid out for a PDF (docs/documents-plan.md → S2, Q7): ONE A4 sheet with the
worker's document — the ID card's front and back, or the passport — and the ספח, then each other page on an
A4 of its own. Used by "Download data" (workerdocs.py) and the old `signing.bundle`, so the layout and the
Hebrew captions are one copy. (S1 freezes a copy of this layout as `builders/sheets_b1.py` for the signed
documents; this one serves only the previews and the bundle, which are never stored.)

The placement follows the pictures' shapes: every way of cutting the sheet's pictures into rows (or into
columns), in their order, is tried, and the one whose smallest picture comes out largest is kept, so an ID
card's two sides go side by side and a tall ספח beside or under them as fits. An ID card worker with no ספח
gets its box left empty, with a Hebrew caption saying it is missing. A stored page that is a JPEG goes in
with its own bytes (no re-encode)."""

import io

HE_KINDS = {"id_front": "תעודת זהות", "id_back": "תעודת זהות (גב)", "passport": "דרכון", "sefach": "ספח", "other": "מסמך"}
HE_MISSING_SEFACH = "ספח — חסר, לא נסרק"
SHEET_KINDS = ("id_front", "id_back", "passport", "sefach")

A4 = (595, 842)
MARGIN = 28
TITLE_H = 30
CAP_H = 18
GAP = 14
EMPTY_ASPECT = 1.58  # the box of a missing ספח: an ID card's shape


def picture_size(data):
    """(width, height) in pixels of a picture, read from its header; None when it is not one."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            return (w, h) if w > 0 and h > 0 else None
    except Exception:
        pass
    try:
        import pymupdf
        pix = pymupdf.Pixmap(data)
        return (pix.width, pix.height) if pix.width > 0 and pix.height > 0 else None
    except Exception:
        return None


def split(pages, passport_worker):
    """The pages ([{kind, data}], in the scan's order) → (the sheet's items, the other pages). An item is
    {kind, data?, size?, caption, empty?}; the first page of each sheet kind goes on the sheet, any further
    one with the other pages. A passport worker's sheet: the passport (and a ספח when one was scanned); an ID
    card worker's: the front, the back when scanned, and the ספח — its box left empty when there is none."""
    first, others = {}, []
    for p in pages:
        k = p.get("kind") if p.get("kind") in HE_KINDS else "other"
        if k in SHEET_KINDS and k not in first:
            first[k] = p
        else:
            others.append(p)
    passport = passport_worker or ("passport" in first and "id_front" not in first)
    if passport:
        order = ["passport", "sefach"]
        others = [first[k] for k in ("id_front", "id_back") if k in first] + others
    else:
        order = ["id_front", "id_back", "sefach"]
        if "passport" in first:
            others.insert(0, first["passport"])
    items = [{"kind": k, "data": first[k]["data"], "caption": HE_KINDS[k]} for k in order if k in first]
    if not passport and items and "sefach" not in first:
        items.append({"kind": "sefach", "caption": HE_MISSING_SEFACH, "empty": True})
    return items, others


def _groups(n):
    """Every way to cut 0..n-1 into consecutive non-empty groups, in order."""
    if n == 0:
        return [[]]
    out = []
    for cut in range(1 << (n - 1)):
        groups, cur = [], [0]
        for i in range(1, n):
            if cut >> (i - 1) & 1:
                groups.append(cur)
                cur = [i]
            else:
                cur.append(i)
        groups.append(cur)
        out.append(groups)
    return out


def _rows_layout(aspects, groups, W, H):
    """Rows stacked down the sheet, each row's pictures side by side at one height → [(i, x, y, w, h)] or None."""
    heights = []
    for g in groups:
        content_w = W - GAP * (len(g) - 1)
        heights.append(content_w / sum(aspects[i] for i in g))
    room = H - CAP_H * len(groups) - GAP * (len(groups) - 1)
    if room <= 0:
        return None
    s = min(1.0, room / sum(heights))
    boxes, y = [], 0.0
    for g, hr in zip(groups, heights):
        h = hr * s
        row_w = sum(aspects[i] * h for i in g) + GAP * (len(g) - 1)
        x = (W - row_w) / 2
        for i in g:
            w = aspects[i] * h
            boxes.append((i, x, y + CAP_H, w, h))
            x += w + GAP
        y += CAP_H + h + GAP
    return boxes


def _cols_layout(aspects, groups, W, H):
    """Columns side by side, each column's pictures stacked at one width → [(i, x, y, w, h)] or None."""
    widths = []
    for g in groups:
        room = H - CAP_H * len(g) - GAP * (len(g) - 1)
        if room <= 0:
            return None
        widths.append(room / sum(1 / aspects[i] for i in g))
    s = min(1.0, (W - GAP * (len(groups) - 1)) / sum(widths))
    boxes, x = [], 0.0
    total = sum(w * s for w in widths) + GAP * (len(groups) - 1)
    x = (W - total) / 2
    for g, wc in zip(groups, widths):
        w, y = wc * s, 0.0
        for i in g:
            h = w / aspects[i]
            boxes.append((i, x, y + CAP_H, w, h))
            y += CAP_H + h + GAP
        x += w + GAP
    return boxes


def layout(aspects, real, W, H):
    """The best placement of pictures with these shapes (width / height) in a W × H area: the one whose smallest
    real picture (real[i]; an empty box does not count) is largest. → [(i, x, y, w, h)], in the items' order."""
    best, score = None, -1.0
    for groups in _groups(len(aspects)):
        for fn in (_rows_layout, _cols_layout):
            boxes = fn(aspects, groups, W, H)
            if not boxes:
                continue
            sizes = [(w * h) ** 0.5 for i, _x, _y, w, h in boxes if real[i]] or [(w * h) ** 0.5 for _i, _x, _y, w, h in boxes]
            sc = min(sizes)
            if sc > score + 1e-6:
                best, score = boxes, sc
    return sorted(best or [], key=lambda b: b[0])


class Writer:
    """Hebrew text on a page: right to left, with the Heebo font (the same as Form 101 and the contracts)."""

    def __init__(self, font_path):
        import pymupdf
        self.font_path = str(font_path)
        self.font = pymupdf.Font(fontfile=self.font_path)
        self.ready = set()  # the pages the font is already on

    def text(self, page, x_right, y, text, size=11, color=(0.25, 0.25, 0.25)):
        from bidi.algorithm import get_display
        if (id(page.parent), page.number) not in self.ready:
            page.insert_font(fontfile=self.font_path, fontname="Heebo")
            self.ready.add((id(page.parent), page.number))
        disp = get_display(str(text))
        page.insert_text((x_right - self.font.text_length(disp, fontsize=size), y), disp, fontname="Heebo", fontsize=size, color=color)


def _picture(page, rect, data):
    """A picture in rect: its own bytes (a JPEG goes in as it is). False when it cannot be placed."""
    try:
        page.insert_image(rect, stream=data, keep_proportion=True)
        return True
    except Exception:
        return False


def add_sheet(doc, items, writer, title):
    """One A4 page with the sheet's items (split above). → how many pictures could not be placed."""
    import pymupdf
    dropped = 0
    usable = []
    for it in items:
        if it.get("empty"):
            usable.append(dict(it, aspect=EMPTY_ASPECT))
            continue
        size = picture_size(it["data"])
        if not size:
            dropped += 1
            continue
        usable.append(dict(it, aspect=size[0] / size[1]))
    if not any(not it.get("empty") for it in usable):
        return dropped
    page = doc.new_page(width=A4[0], height=A4[1])
    W, H = A4[0] - 2 * MARGIN, A4[1] - 2 * MARGIN - TITLE_H
    writer.text(page, A4[0] - MARGIN, MARGIN + 16, title, size=14, color=(0, 0, 0))
    ox, oy = MARGIN, MARGIN + TITLE_H
    for i, x, y, w, h in layout([it["aspect"] for it in usable], [not it.get("empty") for it in usable], W, H):
        it = usable[i]
        rect = pymupdf.Rect(ox + x, oy + y, ox + x + w, oy + y + h)
        writer.text(page, rect.x1, rect.y0 - 5, it["caption"], size=10, color=(0.7, 0.1, 0.1) if it.get("empty") else (0.3, 0.3, 0.3))
        if it.get("empty"):
            page.draw_rect(rect, color=(0.7, 0.7, 0.7), width=1, dashes="[4 3] 0")
            continue
        page.draw_rect(pymupdf.Rect(rect.x0 - 1, rect.y0 - 1, rect.x1 + 1, rect.y1 + 1), color=(0.75, 0.75, 0.75), width=0.8)
        if not _picture(page, rect, it["data"]):
            dropped += 1
    return dropped


def add_page(doc, data, writer, caption):
    """One other page on an A4 of its own, its caption above it. → 1 when it could not be placed, else 0."""
    import pymupdf
    size = picture_size(data)
    if not size:
        return 1
    page = doc.new_page(width=A4[0], height=A4[1])
    writer.text(page, A4[0] - MARGIN, MARGIN + 14, caption, size=12, color=(0.3, 0.3, 0.3))
    W, H = A4[0] - 2 * MARGIN, A4[1] - 2 * MARGIN - TITLE_H
    s = min(W / size[0], H / size[1])
    w, h = size[0] * s, size[1] * s
    rect = pymupdf.Rect(MARGIN + (W - w) / 2, MARGIN + TITLE_H, MARGIN + (W - w) / 2 + w, MARGIN + TITLE_H + h)
    return 0 if _picture(page, rect, data) else 1


def sheet_title(items):
    """The sheet's Hebrew title: what is on it."""
    kinds = [it["kind"] for it in items if not it.get("empty")]
    doc = "דרכון" if "passport" in kinds else "תעודת זהות"
    return doc + (" וספח" if any(it["kind"] == "sefach" and not it.get("empty") for it in items) else "")


def add_scans(doc, pages, passport_worker, font_path):
    """The sheet, then each other page. → (Hebrew labels of what was added, part keys, dropped count)."""
    writer = Writer(font_path)
    items, others = split(pages, passport_worker)
    labels, keys, dropped = [], [], 0
    if items:
        before = doc.page_count
        dropped += add_sheet(doc, items, writer, sheet_title(items))
        if doc.page_count > before:
            labels.append(sheet_title(items))
            keys.append("id-sheet")
    for p in others:
        k = p.get("kind") if p.get("kind") in HE_KINDS else "other"
        if add_page(doc, p["data"], writer, HE_KINDS[k]):
            dropped += 1
        else:
            labels.append(HE_KINDS[k])
            keys.append("scan")
    return labels, keys, dropped
