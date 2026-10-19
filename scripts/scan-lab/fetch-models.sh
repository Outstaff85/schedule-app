#!/usr/bin/env bash
# The scanner lab's models and ONNX Runtime Web, put next to it in the built site
# (docs/scan-plan.md → Scanner lab). No model file is committed. Each base model
# comes from the firm's own Firebase Storage (models/scan/base-v1/, through
# model_store.py, when the deploy's credentials are set); only a model not stored
# there yet is downloaded from its authors — once — and stored. /tmp/models (the
# Actions cache) keeps them between runs.
#   scripts/scan-lab/fetch-models.sh dist/scan-lab
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# The model version this copy uses (models/scan/<version>/ in Storage): a trained version is
# tried in the lab first, then given to the site (docs/scan-plan.md → S6).
export SCAN_MODELS_VERSION="$(cat "$HERE/models-version")"
OUT="$1"; CACHE=/tmp/models/$SCAN_MODELS_VERSION
mkdir -p "$OUT/ort" "$OUT/ort130" "$CACHE"
pip install -q onnx numpy google-cloud-storage
STORE=""
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && python "$HERE/model_store.py" ping; then STORE=1; else echo "Firebase Storage not reachable: the authors' links are used"; fi
# The models' home (docs/hf-plan.md): the public Hugging Face repo, one tag per version, the
# files named by what they do; Firebase Storage (the old names) only while a version is not moved there yet.
HF="https://huggingface.co/OutStaff/scanner-models/resolve/$SCAN_MODELS_VERSION"
hfname() { case "$1" in sa24.onnx) echo edges.onnx;; lite.onnx) echo edges-lite.onnx;; yunet640.onnx) echo face.onnx;; *) echo "$1";; esac; }
fromhf() {
  for i in 1 2 3; do
    code=$(curl -sSL -o "$CACHE/$1.part" -w '%{http_code}' "$HF/$(hfname "$1")" || echo 000)
    if [ "$code" = 200 ] && [ "$(stat -c %s "$CACHE/$1.part")" -gt 100000 ]; then mv "$CACHE/$1.part" "$CACHE/$1"; echo "from Hugging Face: $(hfname "$1")"; return 0; fi
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
get sa24.onnx "$(drive 14vUH77v6yGg7zFctUgcT6BzV5Iisg4Dl)"   # DocAligner, the accurate model (fastvit_sa24), Apache-2.0
get lite.onnx "$(drive 1IlbLPkCv-TdaBLOPh_4J97P1_KHYYJ7a)"   # DocAligner, the light model (lcnet100), the live frame
# The face finder that sets a shot upright (YuNet, MIT, OpenCV zoo).
get yunet640.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
[ -s "$CACHE/yunet_any.onnx" ] || python "$HERE/yunet_dyn.py" "$CACHE/yunet640.onnx" "$CACHE/yunet_any.onnx"   # any input size: run at 320
# fp16 weights, fp32 math: a plain fp16 conversion gives zeros on WebGPU.
[ -s "$CACHE/sa24_w16.onnx" ] || python "$HERE/w16.py" "$CACHE/sa24.onnx" "$CACHE/sa24_w16.onnx"
cp "$CACHE/lite.onnx" "$CACHE/sa24_w16.onnx" "$OUT/" && cp "$CACHE/yunet_any.onnx" "$OUT/yunet.onnx"
# The document type model (docs/scan-plan.md → S7): only once this version has one
# (doctype-lite.onnx in Storage); models.json tells the lab whether it is there.
DOCTYPE=false
if { [ -s "$CACHE/doctype-lite.onnx" ] || fromhf doctype-lite.onnx || { [ -n "$STORE" ] && python "$HERE/model_store.py" get doctype-lite.onnx "$CACHE/doctype-lite.onnx"; }; }; then
  cp "$CACHE/doctype-lite.onnx" "$OUT/doctype.onnx"; DOCTYPE=true
fi
printf '{"version":"%s","doctype":%s}\n' "$SCAN_MODELS_VERSION" "$DOCTYPE" > "$OUT/models.json"
# The lab runs the face finder at 320×320: a file still fixed at 640 fails every shot's turn.
python -c "import onnx,sys; d=onnx.load(sys.argv[1]).graph.input[0].type.tensor_type.shape.dim; sys.exit(0 if d[2].dim_param else 'yunet.onnx is still fixed at %d×%d' % (d[2].dim_value, d[3].dim_value))" "$OUT/yunet.onnx"
# ONNX Runtime Web: 1.22 for the CPU, 1.30 for the GPU (its GPU runs the light model right where 1.22 returned zeros).
T="$(mktemp -d)"
for v in 1.22.0:ort 1.30.0:ort130; do
  (cd "$T" && mkdir -p "${v#*:}" && cd "${v#*:}" && npm pack "onnxruntime-web@${v%%:*}" --silent >/dev/null && tar xzf "onnxruntime-web-${v%%:*}.tgz")
  cp "$T/${v#*:}/package/dist/ort.all.min.js" "$T/${v#*:}"/package/dist/*.wasm "$T/${v#*:}"/package/dist/ort-wasm-simd-threaded*.mjs "$OUT/${v#*:}/"
done
ls -la "$OUT"
