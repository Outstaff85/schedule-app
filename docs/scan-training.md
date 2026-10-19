# Scanner training (how the scanner learns)

The whole training of the scanner in one place: where the examples come from, where they are kept, how a model is trained, checked and handed over, and what the owner does. Approved by the owner on 2026-10-18 (docs/scan-plan.md → S6). The scanner itself is docs/scan.md → The scan window.

## The idea in one line

**The site collects → the owner's PC trains → the lab tries → the site gets the new model.**

```
 site (src/scan/)            Storage / Firestore              owner's PC                 lab (/scan-lab/)        site
 users correct corners  ──►  training/scan/, scanTraining ──► /scan-train: pull, train,  ──► models/scan/v<N>/ ──► tried on the  ──► set for the site
 and page kinds              (kept 12 months)                 exam, publish (on "yes")       set for the lab        phone            when better
```

- **The site's scanner** is the only source of examples: real scans by the firms' users. The lab collects nothing (no login, no data).
- **Firebase Storage** is the shared store: the examples and every model version live there, apart from both copies of the code.
- **The lab and the site never share code or a model file** (CLAUDE.md → Scanner: the lab and the site are apart); each names the model version it uses.

## 1. What is collected (on the site)

In the scan window (docs/scan.md → The scan window):

- **Corners** — a tap on a page opens its photo with the frame the model found; the user drags a corner and taps Apply. The model's corners and the user's are an example.
- **Page kind** — each page shows the kind Haiku gave it (ID card, its back, ספח, passport, contract, other); the user can pick another. Haiku's kind and the user's are an example.

On **Done**, every page the server found is sent in the background to the function `scan_feedback` (`src/scan/server.ts`, `sendFeedback`); with no network the examples wait in a queue on the phone (`localStorage` `scanFeedbackQueue`) and go the next time the scan window opens. A page:

| | sends | kept? |
|---|---|---|
| corners moved (≥ 0.5 % of the photo) | both corners + a 256×256 copy of the part of the photo the model looked at | yes |
| kind changed | both kinds + a 256×256 copy of the page | yes |
| neither — one page in five (`rightSeen`) | its corners and kinds + the same 256×256 copy, marked `keep`, and a 256×256 copy of the page | yes, as "the model was right" (`right: true`) — so the training also learns what the model already does well and does not forget it, and the page-kind model gets pages of every kind, not only Haiku's mistakes |
| neither — the other four | the corners and kinds only | no — only counted |

**What the corner model learns from** is the photo as the model saw it — before it was cut, straightened or enhanced — scaled to 256×256, which is exactly the model's input: the copy, where the model put the corners on it, and where they really are. The cut page is not needed for the corners; it is used only for the page kind, which a future kind model reads on cut pages. Never the full photo; only small copies.

## 2. Where it is kept

`scan_feedback` (`functions/main.py`, checks in `functions/feedback.py`; a manager login's ID token):

- the copies → Storage `training/scan/<YYYY-MM>/<id>.jpg` (corners) and `<id>-page.jpg` (kind);
- the record → Firestore `scanTraining/<id>`: `cornersModel`, `cornersFixed`, `moved`, `kindModel`, `kindFixed`, `kindBy` (who gave `kindModel`: `haiku` or `model`), `right` (a page the model got right, kept as a sample), `source`, `model` (the model version that answered), `tenantId`, `image`, `pageImage`, `createdAt`, `deleteAt`;
- the counts → Firestore `scanTrainingStats/current`: `newSince` (corrections since the last training — the kept right pages do not count), `kept`, `right`, `movedSum`, `kindsSince` (the page copies of each kind, by the kind the user left — for the page-kind model), and after a training `lastTrainedAt`, `lastVersion`, `lastReport`.

**Privacy:** no client can read or write any of it (no Firestore or Storage rule opens them); only `scan_feedback` writes, only `/scan-train` on the owner's PC (the owner's own Google account) reads. Every firm's corrections are used, with no switch (owner, 2026-10-18).

**12 months:** each record has `deleteAt` = +365 days and Firestore deletes it (the TTL policy in `firestore.indexes.json`); the copies under `training/` are deleted after 365 days by a Storage lifecycle rule (`scripts/scan/storage_lifecycle.py`, set by the rules deploy; it needs Storage Admin on the deploy's service account — the deploy warns if it could not set it).

## 3. When to train

When **200** new corrections are kept, the super-admin's bell shows **Time to retrain the scanner** (the server counts; the app asks `scan_feedback` `{"action":"stats"}` at most every 6 hours). When every page kind but "Other" has **100** page copies (`kindsSince`, `feedback.KIND_AT`), it shows **Enough pages for the page-kind model** (`kindsDue`). Nothing trains by itself.

## 4. How a model is trained (`/scan-train` on the owner's PC)

The skill `.claude/skills/scan-train/SKILL.md`, run in Claude Code on the owner's PC (RTX 4070), runs `scripts/scan-train/` step by step:

1. **`pull.py`** — downloads every kept corner example to `~/.scan-train/`; about one in seven (chosen by its id, always the same ones) is kept apart as the **exam** and never trained on.
2. **`train.py`** — fine-tunes both corner models — `lite.onnx` (the phone's live frame) and `sa24.onnx` (the server's accurate one) — starting from the **lab's** current version (`scripts/scan-lab/models-version`):
   - the ONNX file is turned into PyTorch (`onnx2torch`) and checked to answer like the original;
   - each corner becomes a target spot (a Gaussian of the models' own spread, σ ≈ 2.4 heatmap pixels) where the user put it;
   - the loss weighs the spots over the empty background (a plain one makes every peak fade), batch norms keep their statistics, mirrored pages and light changes are added;
   - the trained model is exported back to ONNX and checked again. ~15–30 min on the 4070.
3. **`exam.py`** — the exam pages are read by the old models and the new ones: mean corner error, the share within 2 %, the share not found → a "before → after" report (`~/.scan-train/report.json`). If any model is worse it says **do not publish**.
4. **The owner decides.** **Yes** → **`publish.py`**: the new models go to Storage as the next version `models/scan/v<N>/` (the face finder carried over, the report beside them), the bell's counter is reset, the lab is pointed at `v<N>` (`scripts/scan-lab/models-version`), and the copies on the PC are deleted. **No** → **`clean.py`** deletes the copies; nothing changes.

### The page kinds (S7)

When the bell says **Enough pages for the page-kind model** (every kind but "Other" has 100 page copies), `/scan-train` runs its page-kind steps:
1. **`pull_kinds.py`** — every kept page copy with the kind the user left (and the one Haiku or the model gave); the same one in seven is the exam.
2. **`train_kinds.py`** — two models from ImageNet weights (timm): the phone's (EfficientNet-Lite0, `kind-lite.onnx`) and the server's (Lite2, `kind.onnx`), each with two answers: the kind (6) and the turn the page needs (4) — the turn learned by showing every upright copy at a random quarter turn. Exported to ONNX and checked.
3. **`exam_kinds.py`** — on the exam pages: kind right, how many it is sure of (≥ 90 %) and how right those are, the turn right, and the site's way (the model where sure, Haiku elsewhere) against Haiku alone. A worse model → the next size up (Lite1, Lite2… — owner, 2026-10-19), trained and examined again.
4. **The owner decides** — `publish.py` puts the models into the next version beside the corner models (the counter `kindsSince` reset), or `clean.py`.

The models switch on by themselves once their version is set (the lab first, then the site): a page the model is sure of needs no Haiku.

## 5. Lab first, then the site

- **Lab:** the changed `scripts/scan-lab/models-version` is deployed (PR, merge); `/scan-lab/` then runs `v<N>` and the owner tries it on the phone.
- **Site:** only when the owner says the lab is better, the same version is set in **both** `scripts/scan/models-version` (the phone's light model, `/scan/`) and `functions/scan_models_version.txt` (the server's accurate model; a test keeps the two equal), then deployed.
- **Rollback:** the previous version in the same files; old versions stay in Storage.

At deploy each copy's `fetch-models.sh` takes its version from Storage; only `base-v1` may fall back to the models' authors — a trained version is the firm's own.

## 6. The owner's side

1. The bell says **Time to retrain the scanner**.
2. On the PC: Claude Code in this project → `/scan-train` (the first time it sets up Python and asks the owner to sign in to Google in the browser once).
3. About an hour later: the "before → after" report → **yes** or **no**.
4. Try the new version in the lab (Admin → Scanner lab); if it is better, say so — it is then given to the site.

## Files

| What | Where |
|---|---|
| corner editor, page kinds, sending the examples | `src/scan/Corners.tsx`, `src/scan/kind.ts`, `src/scan/Scanner.tsx`, `src/scan/server.ts` |
| receiving, checks, counts | `functions/main.py` (`scan_feedback`), `functions/feedback.py` |
| the bell's notices | `src/manager/page/header.ts` (`scanTrainingNotice`, `scanKindsNotice`) |
| 12-month deletion | `firestore.indexes.json` (TTL), `scripts/scan/storage_lifecycle.py`, `.github/workflows/deploy-rules.yml` |
| training | `scripts/scan-train/` (corners: `pull.py`, `train.py`, `exam.py`; page kinds: `pull_kinds.py`, `train_kinds.py`, `exam_kinds.py`; both: `publish.py`, `clean.py`, `common.py`, `requirements.txt`), `.claude/skills/scan-train/SKILL.md` |
| the page-kind models at work | `functions/docfind.py` (`kind_of`, `with_kind`), `functions/main.py` (`_kind_model`), `src/scan/core.ts` (`withKind`), `src/scan/worker.ts`, `src/scan/Scanner.tsx` (`withModelKind`), `scan-lab/index.html` (`kindNote`), the deploy's `models.json` (`scripts/scan/fetch-models.sh`, `scripts/scan-lab/fetch-models.sh`) |
| model versions | `scripts/scan-lab/models-version`, `scripts/scan/models-version`, `functions/scan_models_version.txt` |
| tests | `tests/auth/test_scan_feedback.py`, the browser test "scan window corners and kinds" (`tests/e2e/main.test.js`) |
