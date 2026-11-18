# Favilla's hands on a Windows desktop: screenshots, windows, mouse and keyboard.
# Reads one JSON request per line on stdin ({"id":1,"op":"shot",...}) and answers one JSON line on stdout.
# Every input action first checks the stop signal: the mouse parked in the top-left corner of the main screen.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class FavillaWindow {
  public long Handle;
  public string Title;
  public int X, Y, W, H;
  public bool Minimized, Focused;
}

public class FavillaShot {
  public int X, Y, W, H, Width, Height;
  public double Scale;
  public int CursorX, CursorY;
}

public static class FavillaDesk {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

  public static void Init() { SetProcessDPIAware(); }

  /** The user's stop signal: the mouse in the top-left corner of the main screen. */
  public static bool Stopped() {
    POINT p; GetCursorPos(out p);
    return p.X <= 1 && p.Y <= 1;
  }

  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }

  public static int[] Screen() {
    Rectangle v = SystemInformation.VirtualScreen;
    Rectangle m = System.Windows.Forms.Screen.PrimaryScreen.Bounds;
    return new int[] { v.X, v.Y, v.Width, v.Height, m.X, m.Y, m.Width, m.Height };
  }

  static RECT Bounds(IntPtr h) {
    RECT r;
    // The frame Windows draws, without the invisible resize border GetWindowRect includes.
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  public static List<FavillaWindow> Windows() {
    var list = new List<FavillaWindow>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      int n = GetWindowTextLength(h); if (n == 0) return true;
      var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity);
      RECT r = Bounds(h);
      list.Add(new FavillaWindow { Handle = h.ToInt64(), Title = sb.ToString(), X = r.Left, Y = r.Top, W = r.Right - r.Left, H = r.Bottom - r.Top, Minimized = IsIconic(h), Focused = h == fg });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  /** Bring a window to the front; true when it is the foreground window afterwards. */
  public static bool Focus(long handle) {
    IntPtr h = new IntPtr(handle);
    if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(150); }
    IntPtr fg = GetForegroundWindow();
    uint pid; uint other = GetWindowThreadProcessId(fg, out pid); uint me = GetCurrentThreadId();
    // Windows lets a background process take the foreground only while it shares the input of the current one.
    if (other != me) AttachThreadInput(me, other, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (other != me) AttachThreadInput(me, other, false);
    Thread.Sleep(120);
    return GetForegroundWindow() == h;
  }

  public static FavillaShot Shot(int x, int y, int w, int h, int maxW, int maxH, string file) {
    if (w <= 0 || h <= 0) { Rectangle v = SystemInformation.VirtualScreen; x = v.X; y = v.Y; w = v.Width; h = v.Height; }
    double scale = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / h));
    int tw = Math.Max(1, (int)Math.Round(w * scale)), th = Math.Max(1, (int)Math.Round(h * scale));
    POINT c; GetCursorPos(out c);
    using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
      using (var small = new Bitmap(tw, th, PixelFormat.Format24bppRgb)) {
        using (var g2 = Graphics.FromImage(small)) {
          g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g2.DrawImage(bmp, 0, 0, tw, th);
          // Where the mouse is: a ring the model can see (the real cursor is not in a screen copy).
          int cx = (int)Math.Round((c.X - x) * scale), cy = (int)Math.Round((c.Y - y) * scale);
          if (cx >= 0 && cy >= 0 && cx < tw && cy < th) {
            g2.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(Color.FromArgb(230, 255, 255, 255), 3)) g2.DrawEllipse(pen, cx - 7, cy - 7, 14, 14);
            using (var pen = new Pen(Color.FromArgb(230, 220, 40, 40), 1.6f)) g2.DrawEllipse(pen, cx - 7, cy - 7, 14, 14);
          }
        }
        // To a file: a picture is too large to travel well inside a JSON line.
        small.Save(file, ImageFormat.Png);
        return new FavillaShot { X = x, Y = y, W = w, H = h, Width = tw, Height = th, Scale = scale, CursorX = c.X, CursorY = c.Y };
      }
    }
  }

  static INPUT Mouse(uint flags, uint data) {
    var i = new INPUT { type = 0 };
    i.u.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data };
    return i;
  }

  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new Exception("Windows refused the input (a window of higher privilege may have the focus).");
  }

  public static void Move(int x, int y) { SetCursorPos(x, y); Thread.Sleep(30); }

  public static void StrokeMove(int x, int y) {
    if (!SetCursorPos(x, y)) throw new Exception("Windows refused to move the mouse.");
  }

  public static void Button(string button, bool down) {
    uint f = button == "right" ? (down ? 0x0008u : 0x0010u) : button == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
    Send(Mouse(f, 0));
  }

  public static void Click(int x, int y, string button, int count) {
    Move(x, y);
    for (int k = 0; k < count; k++) { Button(button, true); Thread.Sleep(20); Button(button, false); Thread.Sleep(60); }
  }

  public static void Drag(int x1, int y1, int x2, int y2) {
    Move(x1, y1); Button("left", true); Thread.Sleep(80);
    // In steps, so the target sees a drag and not a jump.
    for (int k = 1; k <= 12; k++) { SetCursorPos(x1 + (x2 - x1) * k / 12, y1 + (y2 - y1) * k / 12); Thread.Sleep(15); }
    Thread.Sleep(60); Button("left", false);
  }

  public static void Wheel(int x, int y, int clicks) {
    Move(x, y);
    Send(Mouse(0x0800, unchecked((uint)(clicks * 120))));
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = 1 };
    i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    return i;
  }

  /** Any text, each character as a Unicode key press, so layouts and input methods do not get in the way. */
  public static void Type(string text) {
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') { Send(Key(0x0D, 0, 0), Key(0x0D, 0, 2)); }
      else { Send(Key(0, ch, 4), Key(0, ch, 6)); }
      Thread.Sleep(4);
    }
  }

  static readonly HashSet<int> Extended = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x6F, 0xA3, 0xA5 };

  /** A chord: keys pressed in order and released in reverse (ctrl+shift+t). */
  public static void Keys(int[] vks) {
    var down = new List<INPUT>(); var up = new List<INPUT>();
    foreach (int vk in vks) {
      uint ext = Extended.Contains(vk) ? 1u : 0u;
      down.Add(Key((ushort)vk, 0, ext));
      up.Insert(0, Key((ushort)vk, 0, ext | 2));
    }
    down.AddRange(up);
    Send(down.ToArray());
  }
}
'@

[FavillaDesk]::Init()
function Check-Stroke($permit) {
  if (-not [IO.File]::Exists($permit)) { throw 'The stroke was cancelled.' }
  if ([FavillaDesk]::Stopped()) { throw 'STOP: the mouse is in the top-left corner of the screen, the sign to stop.' }
}

function Invoke-Stroke($r) {
  # Flat triples of screen x, screen y and elapsed ms. One request owns the entire press and release.
  $p = [int[]]$r.samples
  Check-Stroke $r.permit
  [FavillaDesk]::StrokeMove($p[0], $p[1])
  Check-Stroke $r.permit
  try {
    [FavillaDesk]::Button('left', $true)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $last = 0L
    for ($i = 3; $i -lt $p.Length; $i += 3) {
      $due = [Math]::Max([long]$p[$i + 2], $last + 8)
      do {
        Check-Stroke $r.permit
        $left = $due - $clock.ElapsedMilliseconds
        if ($left -gt 0) { [Threading.Thread]::Sleep([int][Math]::Min(16L, $left)) }
      } while ($left -gt 0)
      [FavillaDesk]::StrokeMove($p[$i], $p[$i + 1])
      $last = $clock.ElapsedMilliseconds
    }
  } finally {
    [FavillaDesk]::Button('left', $false)
  }
}

function Reply($id, $ok, $value) {
  $o = if ($ok) { @{ id = $id; ok = $true; result = $value } } else { @{ id = $id; ok = $false; error = "$value" } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
$inputOps = @('move', 'click', 'drag', 'wheel', 'type', 'keys', 'focus')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $r = $line | ConvertFrom-Json
    $id = $r.id
    if ($inputOps -contains $r.op -and [FavillaDesk]::Stopped()) { throw 'STOP: the mouse is in the top-left corner of the screen, the sign to stop.' }
    $value = switch ($r.op) {
      'hello' { @{ screen = [FavillaDesk]::Screen(); pid = $PID } }
      'screen' { , [FavillaDesk]::Screen() }
      'cursor' { , [FavillaDesk]::Cursor() }
      'windows' { , [FavillaDesk]::Windows() }
      'focus' { [FavillaDesk]::Focus([long]$r.handle) }
      'shot' { [FavillaDesk]::Shot([int]$r.x, [int]$r.y, [int]$r.w, [int]$r.h, [int]$r.maxW, [int]$r.maxH, [string]$r.file) }
      'move' { [FavillaDesk]::Move([int]$r.x, [int]$r.y); $true }
      'click' { [FavillaDesk]::Click([int]$r.x, [int]$r.y, [string]$r.button, [int]$r.count); $true }
      'drag' { [FavillaDesk]::Drag([int]$r.x1, [int]$r.y1, [int]$r.x2, [int]$r.y2); $true }
      'stroke' { Invoke-Stroke $r; $true }
      'wheel' { [FavillaDesk]::Wheel([int]$r.x, [int]$r.y, [int]$r.clicks); $true }
      'type' { [FavillaDesk]::Type([string]$r.text); $true }
      'keys' { [FavillaDesk]::Keys([int[]]$r.vks); $true }
      default { throw "Unknown operation $($r.op)" }
    }
    Reply $id $true $value
  } catch {
    Reply $id $false $_.Exception.Message
  }
}
