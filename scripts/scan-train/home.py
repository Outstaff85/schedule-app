"""Where /scan-train keeps its copies on the owner's PC: ~/.scan-train, or the folder the SCAN_TRAIN_HOME
environment variable names (another disk: set SCAN_TRAIN_HOME=D:\\scan-train). Pure: no Google or
Hugging Face packages, so every script and the tests can import it. The scripts print in UTF-8 whatever
the console's code page (a Hebrew Windows' cp1255 has no "→" and stopped them)."""
import hashlib
import os
import pathlib
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

WORK = pathlib.Path(os.environ.get("SCAN_TRAIN_HOME") or pathlib.Path.home() / ".scan-train")
DATA = "OutStaff/scanner-data"   # the training data on Hugging Face (a PRIVATE bucket, docs/hf-plan.md → H7)
HE_FILES = ("he.onnx", "he-layouts.json")   # the Hebrew field reader and where it reads on a card (train_he.py; H8c) — here, so train_he.py needs no Google package


def sha256_of(path):
    """A file's sha256 (hex): what binds an exam's report to the exact model file it examined."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def model_hashes(names, folder=None):
    """{name: sha256} of the files of ~/.scan-train/new/ (or folder) an exam examined — written into its
    report as "model_sha256"; publish.py recomputes them and refuses a report written for another file."""
    folder = pathlib.Path(folder) if folder else WORK / "new"
    return {n: sha256_of(folder / n) for n in names if (folder / n).exists()}


def drop_report(*names):
    """A training that writes a new model deletes the report of the one before (the exam is run again)."""
    for n in names:
        (WORK / n).unlink(missing_ok=True)


def spare_cores(n):
    """The logical cores a drawing run may use and how many processes it starts: off the first physical
    core (logical 0 and 1 with hyper-threading) and two processes fewer than the cores."""
    keep = set(range(2, n)) if n >= 4 else set(range(n))
    return keep, max(1, n - 2)


RESERVE = 0.2   # the share of the free memory a drawing run leaves to the system and the owner's own work (owner, 2026-10-25)


def memory():
    """(free, total) bytes of the PC's memory; (None, None) when it cannot be read."""
    try:
        if sys.platform == "win32":
            import ctypes

            class Status(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            st = Status()
            st.dwLength = ctypes.sizeof(Status)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return None, None
            return st.ullAvailPhys, st.ullTotalPhys
        page = os.sysconf("SC_PAGE_SIZE")
        return os.sysconf("SC_AVPHYS_PAGES") * page, os.sysconf("SC_PHYS_PAGES") * page
    except (OSError, ValueError, AttributeError):
        return None, None


def memory_jobs(jobs, per_process_gb, reserve=RESERVE):
    """The processes a drawing run starts, cut to what the free memory holds (owner, 2026-10-25: a cuts build of
    15 processes, ~1.5 GB each, ran the PC out of memory): free × (1 − reserve) / per process, at least 1 and at
    most jobs. Unknown memory: jobs as asked."""
    free, _ = memory()
    if not free or per_process_gb <= 0:
        return jobs
    fits = int(free * (1 - reserve) / (per_process_gb * 2 ** 30))
    return max(1, min(jobs, fits))


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
