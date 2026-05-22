# Move cursor to the Windows 11 tray-overflow chevron and left-click. Helper
# for vmlab visual smokes — prlctl exec runs as SYSTEM so the only way to
# probe whether our recall-tray icon registered (it may be hidden in the
# "show hidden icons" flyout by default) is to open the flyout itself.
param(
  [int]$X = 3240,
  [int]$Y = 1850
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Mouse {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP   = 0x0004;
}
"@

[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($X, $Y)
Start-Sleep -Milliseconds 200
[Mouse]::mouse_event([Mouse]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Mouse]::mouse_event([Mouse]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Write-Host "clicked ($X,$Y)"
