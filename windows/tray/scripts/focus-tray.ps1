# Send Win+B to focus the notification area, then Enter to open the
# overflow flyout when the chevron is the first focused item. Reliable
# for visual smoke regardless of DPI / resolution because it uses the
# keyboard accelerator the shell guarantees.
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^{ESC}")  # noop: ensure focus is reachable
Start-Sleep -Milliseconds 200
# Win+B shortcut
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Kbd {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    public const byte LWIN = 0x5B;
    public const byte B    = 0x42;
    public const byte ENTER= 0x0D;
    public const uint KEYUP = 0x0002;
}
"@
[Kbd]::keybd_event([Kbd]::LWIN, 0, 0, [IntPtr]::Zero)
[Kbd]::keybd_event([Kbd]::B,    0, 0, [IntPtr]::Zero)
[Kbd]::keybd_event([Kbd]::B,    0, [Kbd]::KEYUP, [IntPtr]::Zero)
[Kbd]::keybd_event([Kbd]::LWIN, 0, [Kbd]::KEYUP, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300
[Kbd]::keybd_event([Kbd]::ENTER, 0, 0, [IntPtr]::Zero)
[Kbd]::keybd_event([Kbd]::ENTER, 0, [Kbd]::KEYUP, [IntPtr]::Zero)
Write-Host "focused tray + opened overflow"
