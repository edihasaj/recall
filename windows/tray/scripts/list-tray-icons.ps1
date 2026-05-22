# Enumerate all toolbar items in the Windows 11 notification area, including
# both the always-visible row and the overflow flyout. UI Automation works
# from the SYSTEM session because it reads the desktop accessibility tree,
# not synthesised input — so we can run it via `prlctl exec` without the
# scheduled-task interactive dance.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cnd  = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::ToolBar)
$bars = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cnd)

foreach ($bar in $bars) {
  $name = $bar.Current.Name
  if (-not $name) { continue }
  # Only the tray toolbars carry "Notification" or "User Promoted" in their name.
  if ($name -notmatch 'Notification|User Promoted|System Promoted|Taskbar overflow') { continue }
  Write-Host "## $name"
  $itemCnd = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $items = $bar.FindAll([System.Windows.Automation.TreeScope]::Children, $itemCnd)
  foreach ($i in $items) {
    Write-Host ("  - " + $i.Current.Name)
  }
}
