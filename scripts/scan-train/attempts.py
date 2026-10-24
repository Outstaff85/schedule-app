"""Every scan attempt as training examples (docs/scan-plan.md → S8; the attempts are collected by
scan_feedback under attempts/new/ — docs/scan-training.md → 2). Pure: no files, no models, so the
rules are tested (tests/auth/test_scan_train_attempts.py); pull.py fetches and paints, train.py and
exam.py use what comes out.

An attempt's pages are its documents in the order they were found: page 0 the first frame
(edgesModel; none when the picture was taken whole), page i the i-th other document (edgesMore).
What each page teaches:
- a kept page: its corners — the ones the user moved (edgesFixed / edgesMoreFixed), else the
  model's own ("self": no corner moved — the model's own answer, which no one touched: a weak label, weight at
  most 0.3 in training and never in the exam; docs/scan-training.md → "Real data and its weight") — on the photo
  with the documents found before it painted over (as the next document search sees it). A page lying inside an
  earlier one (an ID card on its ספח — the lab's findInside finds it on that one's flat cut, not on the photo) is
  marked "on": the earlier page's index; pull.py and gen/real.py write it as that page's flat cut (gen/phone.py
  warp_rgba, not turned) with its corners mapped into the cut, so the photo itself never carries two answers
  (the sheet's and the card's) at once;
- a deleted page — the user did not want it (deletedPages, or a later outcome naming the page;
  an outcome with no page deletes them all): "nothing here" on the photo with the pages found
  before it painted over. A deleted first page of a photo with other documents teaches nothing
  (it is not known which document was meant), nor does a deleted page lying on another;
- a retaken attempt with no corners moved: no right answer is known, so it is never trained on;
  its first page goes to the exam as a hard page (the new model should answer differently)."""

WHOLE = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]


def group_of(d, ans):
    """An attempt's retake group: the group the scanner gave (the first shot's id), else its own id (its folder's last
    part) — pull.py and gen/real.py split a whole group by it."""
    return ans.get("group") or ans.get("id") or d.rsplit("/", 1)[1]


def latest_outcome(outcomes):
    """The later outcomes of an attempt (outcome-<time>.json, oldest first) → the deleted pages:
    a set of page numbers, or "all"."""
    gone = set()
    for o in outcomes:
        if (o or {}).get("outcome") != "deleted":
            continue
        if o.get("page") is None:
            return "all"
        gone.add(int(o["page"]))
    return gone


def _inside(q, outer):
    """Whether quad q lies inside quad outer (its centre and every corner): a document lying on another
    (an ID card on its ספח — the lab's findInside), found on the cut of the one under it."""
    def within(x, y):
        inside, j = False, 3
        for i in range(4):
            (xi, yi), (xj, yj) = outer[i], outer[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        return inside
    cx, cy = sum(p[0] for p in q) / 4, sum(p[1] for p in q) / 4
    return within(cx, cy) and all(within(*p) for p in q)


def examples_of(answer, outcomes=()):
    """The examples one attempt gives: [{"kind": "edges" | "none" | "hard", "page", "target",
    "rejected", "paint", "self", "on"}] — target: the right corners (edges), rejected: the corners the user
    rejected (hard), paint: the frames to paint over first, self: True when no corner of a kept page was moved
    (target is the model's own quad), on: the index of the earlier page it lies inside (its flat cut is the picture;
    paint then []), else None."""
    quads = [answer.get("edgesModel")] + list(answer.get("edgesMore") or [])
    fixed_more = list(answer.get("edgesMoreFixed") or [])
    fixed = [answer.get("edgesFixed")] + [fixed_more[i] if i < len(fixed_more) else None for i in range(len(quads) - 1)]
    later = latest_outcome(outcomes)
    deleted = set(range(len(quads))) if later == "all" else set(answer.get("deletedPages") or []) | later
    if answer.get("outcome") == "retaken":
        if not any(fixed):
            return [{"kind": "hard", "page": 0, "target": None, "rejected": quads[0], "paint": [], "self": False,
                     "on": None}] if quads[0] else []
    out, before = [], []   # before: (page index, its right corners) of the pages kept so far
    for i, q in enumerate(quads):
        if q is None:
            continue  # taken whole: no frame was found, nothing to teach the frame finder
        right = fixed[i] or q
        if i in deleted or answer.get("outcome") == "deleted":
            # (a deleted page lying on another teaches nothing: "nothing here" would be said of the photo
            # with the one under it still on it)
            if (i > 0 or len(quads) == 1) and not any(_inside(q, p) for _, p in before):
                out.append({"kind": "none", "page": i, "target": None, "rejected": q, "paint": [p for _, p in before],
                            "self": False, "on": None})
            continue
        on = next((j for j, p in before if _inside(right, p)), None)
        # a page lying on another is taught on that one's flat cut (nothing painted); the rest on the photo with the
        # pages found before painted over
        out.append({"kind": "edges", "page": i, "target": right, "rejected": None,
                    "paint": [] if on is not None else [p for _, p in before], "self": fixed[i] is None, "on": on})
        before.append((i, right))
    return out
