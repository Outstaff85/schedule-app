"""The scanner's training data generator (docs/scan-training.md → "Kept apart", "Made-up sets: build, verify, QA"):
`python -m gen <command>`. Torch-free and Google-free, so the tests in CI import it. The split rule and the class
table (gen/common.py), the sources registry (gen/sources.py: `sources`), the random streams (gen/rng.py), the manifest,
run.json and the data fingerprint (gen/manifest.py), today's generators through the manifest (gen/build.py: `build`),
drawing a sample again (gen/verify.py: `verify`) and the QA sheet (gen/qa.py: `qa`)."""
