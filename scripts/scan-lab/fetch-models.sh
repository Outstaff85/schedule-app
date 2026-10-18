#!/usr/bin/env bash
# The scanner lab's models and ONNX Runtime Web, put next to it in the built site
# (docs/scan-plan.md → Scanner lab). No model file is committed: they are fetched
# here, at deploy, and kept in /tmp/models (the Actions cache) between runs —
# Drive refuses frequent downloads.
#   scripts/scan-lab/fetch-models.sh dist/scan-lab
set -euo pipefail
OUT="$1"; CACHE=/tmp/models; HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT/ort" "$OUT/ort130" "$CACHE"
get() {  # DocAligner (Apache-2.0) from its author's Drive
  [ -s "$CACHE/$2" ] && return 0
  for i in 1 2 3 4; do
    curl -sSL --fail "https://drive.usercontent.google.com/download?id=$1&export=download&confirm=t" -o "$CACHE/$2" && [ "$(stat -c %s "$CACHE/$2")" -gt 1000000 ] && return 0
    sleep $((i * 5))
  done
  echo "could not download $2"; return 1
}
get 14vUH77v6yGg7zFctUgcT6BzV5Iisg4Dl sa24.onnx   # the accurate model (fastvit_sa24)
get 1IlbLPkCv-TdaBLOPh_4J97P1_KHYYJ7a lite.onnx   # the light model (lcnet100), the live frame
# The face finder that sets a shot upright (YuNet, MIT, OpenCV zoo).
[ -s "$CACHE/yunet640.onnx" ] || curl -sSL --fail -o "$CACHE/yunet640.onnx" https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
pip install -q onnx numpy
[ -s "$CACHE/yunet_any.onnx" ] || python "$HERE/yunet_dyn.py" "$CACHE/yunet640.onnx" "$CACHE/yunet_any.onnx"   # any input size: run at 320
# fp16 weights, fp32 math: a plain fp16 conversion gives zeros on WebGPU.
[ -s "$CACHE/sa24_w16.onnx" ] || python "$HERE/w16.py" "$CACHE/sa24.onnx" "$CACHE/sa24_w16.onnx"
cp "$CACHE/lite.onnx" "$CACHE/sa24_w16.onnx" "$OUT/" && cp "$CACHE/yunet_any.onnx" "$OUT/yunet.onnx"
# The lab runs the face finder at 320×320: a file still fixed at 640 fails every shot's turn.
python -c "import onnx,sys; d=onnx.load(sys.argv[1]).graph.input[0].type.tensor_type.shape.dim; sys.exit(0 if d[2].dim_param else 'yunet.onnx is still fixed at %d×%d' % (d[2].dim_value, d[3].dim_value))" "$OUT/yunet.onnx"
# ONNX Runtime Web: 1.22 for the CPU, 1.30 for the GPU (its GPU runs the light model right where 1.22 returned zeros).
T="$(mktemp -d)"
for v in 1.22.0:ort 1.30.0:ort130; do
  (cd "$T" && mkdir -p "${v#*:}" && cd "${v#*:}" && npm pack "onnxruntime-web@${v%%:*}" --silent >/dev/null && tar xzf "onnxruntime-web-${v%%:*}.tgz")
  cp "$T/${v#*:}/package/dist/ort.all.min.js" "$T/${v#*:}"/package/dist/*.wasm "$T/${v#*:}"/package/dist/ort-wasm-simd-threaded*.mjs "$OUT/${v#*:}/"
done
ls -la "$OUT"
