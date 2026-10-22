"""A model file's batch size set free (train.py): an exported model whose batch was baked in as 1 — the
input's first dimension, and a Reshape's target shape written as a constant [1, …] (v3's edges.onnx,
2026-10-22) — answers only one picture at a time, so it cannot be trained further in batches. The input
and output take a named batch dimension, and each such Reshape's leading 1 becomes 0 (ONNX: the input's
own size there — the batch, whatever it is; onnx2torch reads it the same way)."""
from onnx import numpy_helper


def free_batch(proto):
    """Frees the batch of an ONNX model in place; returns how many Reshape shapes were changed."""
    g = proto.graph
    for v in list(g.input) + list(g.output):
        dims = v.type.tensor_type.shape.dim
        if len(dims):
            dims[0].ClearField("dim_value")
            dims[0].dim_param = "batch"
    inits = {i.name: i for i in g.initializer}
    changed = 0
    for node in g.node:
        if node.op_type == "Reshape" and node.input[1] in inits:
            shape = numpy_helper.to_array(inits[node.input[1]]).copy()
            if shape.ndim == 1 and len(shape) > 1 and shape[0] == 1:
                shape[0] = 0
                inits[node.input[1]].CopyFrom(numpy_helper.from_array(shape, node.input[1]))
                changed += 1
    return changed
