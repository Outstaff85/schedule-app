#!/usr/bin/env bash
# The site scanner's models and ONNX Runtime Web (docs/scan.md → The scan window),
# put into the built site under /scan/ — its own copy, apart from the scanner lab's.
# The base models come from the firm's own Firebase Storage (models/scan/base-v1/,
# through model_store.py, when the deploy's credentials are set), else once from
# their authors. /tmp/scan-models (the Actions cache) keeps them between runs.
#   scripts/scan/fetch-models.sh dist/scan
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# The model version this copy uses (models/scan/<version>/ in Storage): a trained version is
# tried in the lab first, then given to the site (docs/scan-plan.md → S6).
export SCAN_MODELS_VERSION="$(cat "$HERE/models-version")"
OUT="$1"; CACHE=/tmp/scan-models/$SCAN_MODELS_VERSION
mkdir -p "$OUT/ort" "$OUT/ort130" "$CACHE"
pip install -q onnx numpy google-cloud-storage
STORE=""
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && python "$HERE/model_store.py" ping; then STORE=1; else echo "Firebase Storage not reachable: the authors' links are used"; fi
# The models' home (docs/hf-plan.md): the Hugging Face repo, one tag per version, the
# files named by what they do; Firebase Storage (the old names) only while a version is not moved there yet.
HF="https://huggingface.co/OutStaff/scanner-models/resolve/$SCAN_MODELS_VERSION"
# the models' repo is private (owner, 2026-10-24): the deploy reads it with HF_TOKEN, a read-only key for
# that repo alone (a GitHub Actions secret); without it a public repo is still read as before
HF_AUTH=(); [ -n "${HF_TOKEN:-}" ] && HF_AUTH=(-H "Authorization: Bearer $HF_TOKEN")
hfname() { case "$1" in sa24.onnx) echo edges.onnx;; lite.onnx) echo edges-lite.onnx;; yunet640.onnx) echo face.onnx;; *) echo "$1";; esac; }
fromhf() {  # NAME [the least size in bytes: 100 kB, a model; a small file passes its own]
  for i in 1 2 3; do
    code=$(curl -sSL "${HF_AUTH[@]}" -o "$CACHE/$1.part" -w '%{http_code}' "$HF/$(hfname "$1")" || echo 000)
    if [ "$code" = 200 ] && [ "$(stat -c %s "$CACHE/$1.part")" -gt "${2:-100000}" ]; then mv "$CACHE/$1.part" "$CACHE/$1"; echo "from Hugging Face: $(hfname "$1")"; return 0; fi
    rm -f "$CACHE/$1.part"
    case "$code" in 401|403|404) return 1;; esac  # not there: the version is not moved yet
    sleep $((i * 5))
  done
  return 1
}
# get NAME URL: the cache, else Hugging Face, else the firm's Storage, else the authors' link (then stored).
get() {
  [ -s "$CACHE/$1" ] && return 0
  fromhf "$1" && return 0
  [ -n "$STORE" ] && python "$HERE/model_store.py" get "$1" "$CACHE/$1" && return 0
  # only the base models may come from their authors; a trained version is the firm's own
  [ "$SCAN_MODELS_VERSION" = base-v1 ] || { echo "$1 is not in models/scan/$SCAN_MODELS_VERSION"; return 1; }
  for i in 1 2 3 4; do
    curl -sSL --fail "$2" -o "$CACHE/$1" && [ "$(stat -c %s "$CACHE/$1")" -gt 100000 ] && break
    rm -f "$CACHE/$1"; sleep $((i * 5))
  done
  [ -s "$CACHE/$1" ] || { echo "could not download $1"; return 1; }
  [ -z "$STORE" ] || python "$HERE/model_store.py" put "$CACHE/$1" "$1"
}
drive() { echo "https://drive.usercontent.google.com/download?id=$1&export=download&confirm=t"; }
# DocAligner, the light model (lcnet100, Apache-2.0): the live frame.
get lite.onnx "$(drive 1IlbLPkCv-TdaBLOPh_4J97P1_KHYYJ7a)"
# DocAligner, the accurate model (fastvit_sa24, Apache-2.0), under the lab's name: the scanner refines a shot's
# corners and finds its other documents with it (src/scan/engine/shot.ts) — fp16 weights, fp32 math.
get sa24.onnx "$(drive 14vUH77v6yGg7zFctUgcT6BzV5Iisg4Dl)"
[ -s "$CACHE/sa24_w16.onnx" ] || python "$HERE/w16.py" "$CACHE/sa24.onnx" "$CACHE/sa24_w16.onnx"
# The face finder that sets a shot upright (YuNet, MIT, OpenCV zoo), its input size freed to run at 320.
get yunet640.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
[ -s "$CACHE/yunet_any.onnx" ] || python "$HERE/yunet_dyn.py" "$CACHE/yunet640.onnx" "$CACHE/yunet_any.onnx"
cp "$CACHE/lite.onnx" "$CACHE/sa24_w16.onnx" "$OUT/" && cp "$CACHE/yunet_any.onnx" "$OUT/yunet.onnx"
# The phone's document type model (docs/scan-plan.md → S7): only once this version has one
# (doctype-lite.onnx in Storage); models.json tells the scanner whether it is there.
DOCTYPE=false
if { [ -s "$CACHE/doctype-lite.onnx" ] || fromhf doctype-lite.onnx || { [ -n "$STORE" ] && python "$HERE/model_store.py" get doctype-lite.onnx "$CACHE/doctype-lite.onnx"; }; }; then
  cp "$CACHE/doctype-lite.onnx" "$OUT/doctype.onnx"; DOCTYPE=true
fi
# The passport zone reader (docs/hf-plan.md → H8b): only once this version has one (mrz.onnx on Hugging Face).
MRZ=false
if { [ -s "$CACHE/mrz.onnx" ] || fromhf mrz.onnx; }; then cp "$CACHE/mrz.onnx" "$OUT/mrz.onnx"; MRZ=true; fi
# The Hebrew field reader (docs/hf-plan.md → H8c) and the card layouts it reads: only once this version has both.
HE=false
if { [ -s "$CACHE/he.onnx" ] || fromhf he.onnx; } && { [ -s "$CACHE/he-layouts.json" ] || fromhf he-layouts.json 10; }; then
  cp "$CACHE/he.onnx" "$CACHE/he-layouts.json" "$OUT/"; HE=true
fi
# models.json: the version, whether a document type model, a passport zone reader and a Hebrew field reader are there, and each model file's fingerprint
# (sha256, 16 hex) — the phone keeps a model by it and asks the server nothing while it is the same.
python - "$OUT" "$SCAN_MODELS_VERSION" "$DOCTYPE" "$MRZ" "$HE" <<'PY'
import hashlib, json, pathlib, sys
out, version, doctype, mrz, he = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3] == "true", sys.argv[4] == "true", sys.argv[5] == "true"
files = {f.name: hashlib.sha256(f.read_bytes()).hexdigest()[:16] for f in sorted(out.glob("*.onnx"))}
(out / "models.json").write_text(json.dumps({"version": version, "doctype": doctype, "mrz": mrz, "he": he, "files": files}) + "\n")
PY
python -c "import onnx,sys; d=onnx.load(sys.argv[1]).graph.input[0].type.tensor_type.shape.dim; sys.exit(0 if d[2].dim_param else 'yunet.onnx is still fixed at %d×%d' % (d[2].dim_value, d[3].dim_value))" "$OUT/yunet.onnx"
# ONNX Runtime Web: 1.22 for the CPU, 1.30 for the GPU (its GPU runs the light model right where 1.22 returned zeros).
# ort.all.min.mjs is what the scanner's engine imports at run time (src/scan/engine/ort.ts); the
# ort-wasm-simd-threaded*.mjs are what both builds' wasm loaders import (docs/build.md → The scanner's entries).
T="$(mktemp -d)"
for v in 1.22.0:ort 1.30.0:ort130; do
  (cd "$T" && mkdir -p "${v#*:}" && cd "${v#*:}" && npm pack "onnxruntime-web@${v%%:*}" --silent >/dev/null && tar xzf "onnxruntime-web-${v%%:*}.tgz")
  cp "$T/${v#*:}/package/dist/ort.all.min.mjs" "$T/${v#*:}"/package/dist/*.wasm "$T/${v#*:}"/package/dist/ort-wasm-simd-threaded*.mjs "$OUT/${v#*:}/"
done
cp "$HERE/THIRD-PARTY.txt" "$OUT/"
# What the surface's page loads at run time, all from its own folder (docs/build.md → The scanner's entries): the models,
# models.json at this version, he-layouts.json when the Hebrew reader is there, and both ONNX Runtime builds — the .mjs
# the scanner's engine imports (src/scan/engine/ort.ts), its .wasm and loaders. A deploy missing one stops here.
python - "$OUT" "$SCAN_MODELS_VERSION" <<'PY'
import json, pathlib, sys
out, version = pathlib.Path(sys.argv[1]), sys.argv[2]
m = json.loads((out / "models.json").read_text())
need = ["lite.onnx", "sa24_w16.onnx", "yunet.onnx"] + [f"{d}/{f}" for d in ("ort", "ort130") for f in ("ort.all.min.mjs",)]
need += ["doctype.onnx"] * m["doctype"] + ["mrz.onnx"] * m["mrz"] + ["he.onnx", "he-layouts.json"] * m["he"]
missing = [f for f in need if not (out / f).is_file() or (out / f).stat().st_size == 0]
for d in ("ort", "ort130"):
    if not list((out / d).glob("*.wasm")) or not list((out / d).glob("ort-wasm-simd-threaded*.mjs")): missing.append(d + "/ (its .wasm and loader .mjs)")
if m["version"] != version: missing.append(f"models.json says {m['version']}, models-version {version}")
sys.exit("not put next to the page in " + str(out) + ": " + ", ".join(missing) if missing else 0)
PY
ls -la "$OUT"
