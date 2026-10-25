"""When the owner says no to a training: the examples' copies and the new models are
deleted from this PC (the MIDV download and the background bank are kept: common.clear_work), and each training's
progress that was not published is set aside — its model's published weights back in place (checkpoint.set_aside_rejected);
nothing in Storage changes."""
import checkpoint
from common import WORK, clear_work

for name, what in checkpoint.set_aside_rejected():
    print(f"checkpoints/{name}.pt: set aside in checkpoints/rejected/ — {what}")
clear_work()
print(f"Deleted the copies in {WORK}")
