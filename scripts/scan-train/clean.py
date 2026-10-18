"""When the owner says no to a training: the examples' copies and the new models are
deleted from this PC; nothing in Storage changes."""
import shutil

from common import WORK

shutil.rmtree(WORK, ignore_errors=True)
print(f"Deleted {WORK}")
