param(
  [ValidateSet('list','minimize','close')][string]$Action = 'list',
  [string]$Hwnds = '',
  [int]$ExcludePid = 0
)
$sig = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static List<IntPtr> All() {
    var r = new List<IntPtr>();
    EnumWindows((h, p) => { if (IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
}
"@
if (-not ('WinEnum' -as [type])) { Add-Type -TypeDefinition $sig | Out-Null }

function Get-WinList {
  $out = @()
  foreach ($h in [WinEnum]::All()) {
    [uint32]$wpid = 0
    [void][WinEnum]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($wpid -eq 0 -or $wpid -eq $ExcludePid) { continue }
    $sb = New-Object System.Text.StringBuilder 512
    [void][WinEnum]::GetWindowTextW($h, $sb, 512)
    $title = $sb.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) { continue }
    $cs = New-Object System.Text.StringBuilder 256
    [void][WinEnum]::GetClassNameW($h, $cs, 256)
    $cls = $cs.ToString()
    if ($cls -eq 'Progman' -or $cls -eq 'WorkerW' -or $cls -eq 'Shell_TrayWnd') { continue }
    $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
    $exe = ''
    $start = ''
    if ($proc) { $exe = $proc.ProcessName; try { $start = $proc.StartTime.ToUniversalTime().ToString('o') } catch { $start = '' } }
    $out += [pscustomobject]@{
      hwnd = $h.ToInt64(); pid = [int]$wpid; exe = $exe; title = $title;
      className = $cls; minimized = [WinEnum]::IsIconic($h); startedAt = $start
    }
  }
  return $out
}

switch ($Action) {
  'list' { @(Get-WinList) | ConvertTo-Json -Compress -Depth 3 }
  default {
    if ([string]::IsNullOrWhiteSpace($Hwnds)) { '[]' ; exit 0 }
    $ids = $Hwnds.Split(',') | ForEach-Object { [int64]$_.Trim() }
    $res = @()
    foreach ($id in $ids) {
      $h = [IntPtr]$id
      if ($Action -eq 'minimize') { $ok = [WinEnum]::ShowWindow($h, 6) }
      else { $ok = [WinEnum]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
      $res += [pscustomobject]@{ hwnd = $id; ok = $ok }
    }
    @($res) | ConvertTo-Json -Compress
  }
}
