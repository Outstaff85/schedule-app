"""Where /scan-train keeps its copies on the owner's PC: ~/.scan-train, or the folder the SCAN_TRAIN_HOME
environment variable names (another disk: set SCAN_TRAIN_HOME=D:\\scan-train). Pure: no Google or
Hugging Face packages, so every script and the tests can import it."""
import os
import pathlib

WORK = pathlib.Path(os.environ.get("SCAN_TRAIN_HOME") or pathlib.Path.home() / ".scan-train")
DATA = "OutStaff/scanner-data"   # the training data on Hugging Face (a PRIVATE bucket, docs/hf-plan.md → H7)
