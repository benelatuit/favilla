# Puts a folder on the user's Path or takes it off: user-path.ps1 add|remove <folder>. The installer runs it for the
# favilla and fav commands (installer.nsh). The value is edited as it is stored, %VARIABLES% unexpanded and whatever
# its length, and every other entry stays exactly as it was.
param(
  [Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory)][string]$Dir
)
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $want = $Dir.Trim().TrimEnd('\')
  $ours = { param($entry) $entry.Trim().TrimEnd('\') -eq $want }
  $entries = if ($old) { @($old -split ';') } else { @() }
  if ($Action -eq 'add') {
    if (@($entries | Where-Object { & $ours $_ }).Count) { return }
    $base = $old.TrimEnd(';')
    $new = if ($base) { "$base;$Dir" } else { $Dir }
  } else {
    $new = @($entries | Where-Object { -not (& $ours $_) }) -join ';'
    if ($new -eq $old) { return }
  }
  if ($new) { $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
  else { $key.DeleteValue('Path', $false) }
} finally {
  $key.Close()
}
