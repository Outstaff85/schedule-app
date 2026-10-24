# The scanner lab's face finder (docs/scan-plan.md → Scanner lab): YuNet's ONNX
# file is fixed at 640×640; this frees the input size, so the lab runs it on
# 320×320 — a quarter of the work, the same turns found (40 of 40 on the owner's photos).
# scripts/scan-train/gen/phone_run.py frees it the same way (free) before it runs the lab's face turn.
import onnx, sys


def free(m):
    """The model (onnx.ModelProto) with its input's height and width and its outputs' count left free."""
    for d in m.graph.input[0].type.tensor_type.shape.dim[2:]: d.dim_param = 'n'
    for o in m.graph.output: o.type.tensor_type.shape.dim[1].dim_param = 'k'
    del m.graph.value_info[:]
    return m


if __name__ == '__main__':
    onnx.save(free(onnx.load(sys.argv[1])), sys.argv[2])
