"""When the owner says no to a training: the examples' copies and the new models are
deleted from this PC (the MIDV download is kept: common.clear_work); nothing in Storage changes."""
from common import WORK, clear_work

clear_work()
print(f"Deleted the copies in {WORK}")
