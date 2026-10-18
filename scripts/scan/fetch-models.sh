#!/usr/bin/env bash
# The site scanner's models and ONNX Runtime Web (docs/scan.md → The scan window),
# put into the built site under /scan/ — its own copy, apart from the scanner lab's.
# The base models come from the firm's own Firebase Storage (models/scan/base-v1/,
# through model_store.py, when the deploy's credentials are set), else once from
# their authors. /tmp/scan-models (the Actions cache) keeps them between runs.
#   scripts/scan/fetch-models.sh dist/scan
set -euo pipefail
OUT="$1"; CACHE=/tmp/scan-models; HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT/ort" "$OUT/ort130" "$CACHE"
pip install -q onnx google-cloud-storage
STORE=""
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && python "$HERE/model_store.py" ping; then STORE=1; else echo "Firebase Storage not reachable: the authors' links are used"; fi
# get NAME URL: the cache, else the firm's Storage, else the authors' link (then stored).
get() {
  [ -s "$CACHE/$1" ] && return 0
  [ -n "$STORE" ] && python "$HERE/model_store.py" get "$1" "$CACHE/$1" && return 0
  for i in 1 2 3 4; do
    curl -sSL --fail "$2" -o "$CACHE/$1" && [ "$(stat -c %s "$CACHE/$1")" -gt 100000 ] && break
    rm -f "$CACHE/$1"; sleep $((i * 5))
  done
  [ -s "$CACHE/$1" ] || { echo "could not download $1"; return 1; }
  [ -z "$STORE" ] || python "$HERE/model_store.py" put "$CACHE/$1" "$1"
}
drive() { echo "https://drive.usercontent.google.com/download?id=$1&export=download&confirm=t"; }
# DocAligner, the light model (lcnet100, Apache-2.0): the live frame. The accurate model runs on the server.
get lite.onnx "$(drive 1IlbLPkCv-TdaBLOPh_4J97P1_KHYYJ7a)"
# The face finder that sets a shot upright (YuNet, MIT, OpenCV zoo), its input size freed to run at 320.
get yunet640.onnx https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
[ -s "$CACHE/yunet_any.onnx" ] || python "$HERE/yunet_dyn.py" "$CACHE/yunet640.onnx" "$CACHE/yunet_any.onnx"
cp "$CACHE/lite.onnx" "$OUT/" && cp "$CACHE/yunet_any.onnx" "$OUT/yunet.onnx"
python -c "import onnx,sys; d=onnx.load(sys.argv[1]).graph.input[0].type.tensor_type.shape.dim; sys.exit(0 if d[2].dim_param else 'yunet.onnx is still fixed at %d×%d' % (d[2].dim_value, d[3].dim_value))" "$OUT/yunet.onnx"
# ONNX Runtime Web: 1.22 for the CPU, 1.30 for the GPU (its GPU runs the light model right where 1.22 returned zeros).
T="$(mktemp -d)"
for v in 1.22.0:ort 1.30.0:ort130; do
  (cd "$T" && mkdir -p "${v#*:}" && cd "${v#*:}" && npm pack "onnxruntime-web@${v%%:*}" --silent >/dev/null && tar xzf "onnxruntime-web-${v%%:*}.tgz")
  cp "$T/${v#*:}/package/dist/ort.all.min.js" "$T/${v#*:}"/package/dist/*.wasm "$T/${v#*:}"/package/dist/ort-wasm-simd-threaded*.mjs "$OUT/${v#*:}/"
done
cp "$HERE/THIRD-PARTY.txt" "$OUT/"
ls -la "$OUT"
