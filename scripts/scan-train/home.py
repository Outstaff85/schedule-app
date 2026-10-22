"""Where /scan-train keeps its copies on the owner's PC: ~/.scan-train, or the folder the SCAN_TRAIN_HOME
environment variable names (another disk: set SCAN_TRAIN_HOME=D:\\scan-train). Pure: no Google or
Hugging Face packages, so every script and the tests can import it. The scripts print in UTF-8 whatever
the console's code page (a Hebrew Windows' cp1255 has no "→" and stopped them)."""
import os
import pathlib
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

WORK = pathlib.Path(os.environ.get("SCAN_TRAIN_HOME") or pathlib.Path.home() / ".scan-train")
DATA = "OutStaff/scanner-data"   # the training data on Hugging Face (a PRIVATE bucket, docs/hf-plan.md → H7)


def spare_cores(n):
    """The logical cores a drawing run may use and how many processes it starts: off the first physical
    core (logical 0 and 1 with hyper-threading) and two processes fewer than the cores."""
    keep = set(range(2, n)) if n >= 4 else set(range(n))
    return keep, max(1, n - 2)


def gentle(spare_core=True):
    """The run gives way to the owner's own work (owner, 2026-10-22: with every core drawing the PC
    slowed down and could hang): below-normal priority and, with spare_core, the first core left free
    (spare_cores). The processes it starts (a Pool, a DataLoader's workers) inherit both. Returns the
    number of processes to draw with."""
    n = os.cpu_count() or 1
    keep, jobs = spare_cores(n)
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes
            k = ctypes.WinDLL("kernel32", use_last_error=True)
            k.GetCurrentProcess.restype = wintypes.HANDLE
            k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            k.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.c_size_t]
            me = k.GetCurrentProcess()
            k.SetPriorityClass(me, 0x4000)   # BELOW_NORMAL_PRIORITY_CLASS
            if spare_core and len(keep) < n:
                k.SetProcessAffinityMask(me, sum(1 << i for i in keep))
        else:
            os.nice(10)
            if spare_core and len(keep) < n and hasattr(os, "sched_setaffinity"):
                os.sched_setaffinity(0, keep)
    except (OSError, AttributeError, ValueError):
        pass   # not allowed here: the run goes on as before
    return jobs
