# Drives ONE Cursor window whose title contains $Match. Every key send is refused
# unless that exact window is in the foreground; screenshots cover that window only.
#   cursor-window.ps1 -Match gui-check -Keys '^+p||wait:700||Focus on Room View||wait:900' -Shot out.png
#   -Keys is SendKeys syntax split on '||' ({ENTER}, {ESC}, ^ = Ctrl, + = Shift); wait:<ms> pauses.
#   -Action focus only focuses; no -Keys/-Action just reports (and -Shot screenshots).
param([string]$Match = 'gui-check', [string]$Action, [string]$Keys, [string]$Shot)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}
'@
function Find-Win {
  $script:found = [IntPtr]::Zero
  [W]::EnumWindows({ param($h, $l) if ([W]::IsWindowVisible($h) -and ([W]::Title($h) -like "*$Match*Cursor*")) { $script:found = $h; return $false }; $true }, [IntPtr]::Zero) | Out-Null
  $script:found
}
$h = Find-Win
if ($h -eq [IntPtr]::Zero) { 'NO WINDOW'; exit 2 }
function Focus {
  [W]::ShowWindow($h, 3) | Out-Null                       # maximize
  [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)  # Alt tap lets SetForegroundWindow succeed
  [W]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 400
  [W]::GetForegroundWindow() -eq $h
}
if ($Action -eq 'focus' -or $Keys) {
  if (-not (Focus)) { "REFUSED: foreground is '$([W]::Title([W]::GetForegroundWindow()))'"; exit 3 }
}
if ($Keys) {
  foreach ($k in ($Keys -split '\|\|')) {
    if ([W]::GetForegroundWindow() -ne $h) { "REFUSED mid-sequence: foreground is '$([W]::Title([W]::GetForegroundWindow()))'"; exit 3 }
    if ($k -match '^wait:(\d+)$') { Start-Sleep -Milliseconds $Matches[1]; continue }
    [System.Windows.Forms.SendKeys]::SendWait($k)
    Start-Sleep -Milliseconds 250
  }
}
if ($Shot) {
  $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
  $L = [Math]::Max(0, $r.L); $T = [Math]::Max(0, $r.T)
  $wd = [Math]::Min(1920, $r.R) - $L; $ht = [Math]::Min(1080, $r.B) - $T
  $bmp = New-Object System.Drawing.Bitmap $wd, $ht
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($L, $T, 0, 0, $bmp.Size)
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
}
"OK '$([W]::Title($h))' foreground=$([W]::GetForegroundWindow() -eq $h)"
