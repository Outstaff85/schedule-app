# The scanner lab's face finder (docs/scan-plan.md → Scanner lab): YuNet's ONNX
# file is fixed at 640×640; this frees the input size, so the lab runs it on
# 320×320 — a quarter of the work, the same turns found (40 of 40 on the owner's photos).
import onnx, sys
m = onnx.load(sys.argv[1])
for d in m.graph.input[0].type.tensor_type.shape.dim[2:]: d.dim_param = 'n'
for o in m.graph.output: o.type.tensor_type.shape.dim[1].dim_param = 'k'
del m.graph.value_info[:]
onnx.save(m, sys.argv[2])
