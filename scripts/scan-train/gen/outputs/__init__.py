"""The writers of a made-up set per model, from one scene each (docs/scan-training.md → "Scenes: one camera for the
table and the documents"): gen/outputs/edges.py — the document edges models' frames and examples.json (`python -m gen
build --model edges`). Each writer is a generator module of gen/build.py (MODEL, CHUNK, gen_args, gen_params,
gen_prepare, gen_jobs, _batch, gen_write)."""
