"""The writers of a made-up set per model, from one scene each (docs/scan-training.md → "Scenes: one camera for the
table and the documents"): gen/outputs/edges.py — the document edges models' frames and examples.json (`python -m gen
build --model edges`), a generator module of gen/build.py (MODEL, CHUNK, gen_args, gen_params, gen_prepare,
gen_jobs, _batch, gen_write); and the writers of the phone's own cuts (gen/phone_run.py — `python -m gen build --model
doctype,mrz,he,face`; docs/scan-training.md → "The phone's own cuts"): gen/outputs/doctype.py, mrz.py, he.py, face.py,
each write(folder, one scene's cuts, ctx) → (entries, files) and finish(folder, entries, params) → its summary."""
