# The weak-phone simulator's CPU brake (docs/tests.md -> The weak-phone simulator): Chrome's Emulation.setCPUThrottlingRate
# slows the page's main thread only and is refused on a worker target, so the real slowdown comes from the system: every
# renderer process is suspended and resumed in a short cycle, which slows each of its threads, the page's and the
# background threads' alike, by the rate, and its affinity holds it to the profile's number of cores. Windows only.
# It reads one command per line on stdin:
#   set <rate> <affinity mask, hex> <pid,pid,...>   the rate from now on, these processes added (their affinity set)
#   off                                             no brake, every process forgotten
#   mem <pid,pid,...>                               answers "mem pid=peak working set in bytes,..."
#   quit
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SimBrake {
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool SetProcessAffinityMask(IntPtr h, UIntPtr mask);
  const uint ACCESS = 0x0800 | 0x0200 | 0x0400;  // suspend and resume, set and query information
  const double CYCLE_MS = 24;
  static readonly object gate = new object();
  static readonly Dictionary<int, IntPtr> procs = new Dictionary<int, IntPtr>();
  static volatile bool quit;
  static double rate = 1;

  static void Spin(Stopwatch sw, double untilMs) { while (sw.Elapsed.TotalMilliseconds < untilMs) Thread.SpinWait(50); }

  static void Cycle() {
    var sw = Stopwatch.StartNew();
    double next = 0;
    while (!quit) {
      double r;
      lock (gate) {
        r = rate;
        if (r > 1 && procs.Count > 0) {
          foreach (var h in procs.Values) NtSuspendProcess(h);
          Spin(sw, next + CYCLE_MS * (1 - 1 / r));
          foreach (var h in procs.Values) NtResumeProcess(h);
        }
      }
      if (r <= 1) { Thread.Sleep(5); next = sw.Elapsed.TotalMilliseconds; continue; }
      next += CYCLE_MS;
      if (sw.Elapsed.TotalMilliseconds > next + CYCLE_MS) next = sw.Elapsed.TotalMilliseconds;  // never catching up after a stall
      Spin(sw, next);
    }
  }

  static int[] Pids(string s) {
    var o = new List<int>();
    foreach (var t in s.Split(',')) { if (t.Length > 0) o.Add(int.Parse(t, CultureInfo.InvariantCulture)); }
    return o.ToArray();
  }

  public static void Run() {
    var t = new Thread(Cycle) { IsBackground = true, Priority = ThreadPriority.Highest };
    t.Start();
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var a = line.Trim().Split(' ');
      if (a[0] == "quit") break;
      if (a[0] == "off") {
        lock (gate) { rate = 1; foreach (var h in procs.Values) CloseHandle(h); procs.Clear(); }
      } else if (a[0] == "set") {
        var mask = new UIntPtr(ulong.Parse(a[2], NumberStyles.HexNumber, CultureInfo.InvariantCulture));
        lock (gate) {
          rate = double.Parse(a[1], CultureInfo.InvariantCulture);
          foreach (var pid in Pids(a.Length > 3 ? a[3] : "")) {
            if (procs.ContainsKey(pid)) continue;
            var h = OpenProcess(ACCESS, false, pid);
            if (h == IntPtr.Zero) continue;
            if (mask != UIntPtr.Zero) SetProcessAffinityMask(h, mask);
            procs[pid] = h;
          }
        }
      } else if (a[0] == "mem") {
        var o = new StringBuilder("mem ");
        foreach (var pid in Pids(a.Length > 1 ? a[1] : "")) {
          try { using (var p = Process.GetProcessById(pid)) { o.Append(pid).Append('=').Append(p.PeakWorkingSet64).Append(','); } } catch (Exception) { }
        }
        Console.Out.WriteLine(o.ToString());
        Console.Out.Flush();
      }
    }
    quit = true;
    t.Join(500);
    lock (gate) { foreach (var h in procs.Values) { NtResumeProcess(h); CloseHandle(h); } procs.Clear(); }
  }
}
'@
Add-Type -TypeDefinition $source
[SimBrake]::Run()
