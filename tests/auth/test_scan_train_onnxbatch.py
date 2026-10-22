"""A model whose batch was baked in as 1 set free for training in batches (scripts/scan-train/onnxbatch.py,
used by train.py on loading and after exporting): the input and output take a named batch dimension, a
Reshape's constant leading 1 becomes 0 (the input's own batch), and nothing else is touched."""
import importlib.util
import pathlib
import sys

import numpy as np
from onnx import TensorProto, helper, numpy_helper

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))
_spec = importlib.util.spec_from_file_location("onnxbatch", HERE / "onnxbatch.py")
onnxbatch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(onnxbatch)


def model():
    inits = [numpy_helper.from_array(np.array(v, np.int64), n) for n, v in
             (("baked", [1, 512, -1]), ("five", [1, 64, 3, 16, 32]), ("free", [-1, 64]), ("split", [1, 1, 1]))]
    nodes = [helper.make_node("Reshape", ["x", "baked"], ["a"]),
             helper.make_node("Reshape", ["a", "five"], ["b"]),
             helper.make_node("Reshape", ["b", "free"], ["c"]),
             helper.make_node("Split", ["c", "split"], ["s1", "s2", "s3"], axis=1)]
    g = helper.make_graph(nodes, "m", [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 512, 8, 8])],
                          [helper.make_tensor_value_info("s1", TensorProto.FLOAT, [1, 1])], inits)
    return helper.make_model(g)


def shapes(proto):
    return {i.name: numpy_helper.to_array(i).tolist() for i in proto.graph.initializer}


def test_baked_batch_set_free():
    m = model()
    assert onnxbatch.free_batch(m) == 2
    s = shapes(m)
    assert s["baked"] == [0, 512, -1] and s["five"] == [0, 64, 3, 16, 32]
    assert s["free"] == [-1, 64]          # already free: left as it is
    assert s["split"] == [1, 1, 1]        # not a Reshape's shape: left as it is
    for v in (m.graph.input[0], m.graph.output[0]):
        d = v.type.tensor_type.shape.dim[0]
        assert d.dim_param == "batch" and not d.HasField("dim_value")
    assert [d.dim_value for d in m.graph.input[0].type.tensor_type.shape.dim[1:]] == [512, 8, 8]


def test_free_model_unchanged():
    m = model()
    onnxbatch.free_batch(m)
    assert onnxbatch.free_batch(m) == 0   # a second pass finds nothing to change
