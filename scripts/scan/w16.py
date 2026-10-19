# The site scanner's accurate model (docs/scan.md → The scan window): stores the weights as fp16 with a Cast to
# fp32 in front, so the file is half the size and the math stays fp32. The site's own copy of the lab's scripts/scan-lab/w16.py.
import onnx, sys, numpy as np
from onnx import numpy_helper, helper, TensorProto
m = onnx.load(sys.argv[1]); g = m.graph
casts, inits = [], []
for t in g.initializer:
    if t.data_type == TensorProto.FLOAT and np.prod(t.dims) >= 16:
        a = numpy_helper.to_array(t).astype(np.float16)
        n = numpy_helper.from_array(a, t.name + '__h'); inits.append(n)
        casts.append(helper.make_node('Cast', [n.name], [t.name], to=TensorProto.FLOAT))
    else: inits.append(t)
del g.initializer[:]; g.initializer.extend(inits)
nodes = casts + list(g.node); del g.node[:]; g.node.extend(nodes)
onnx.checker.check_model(m); onnx.save(m, sys.argv[2])
