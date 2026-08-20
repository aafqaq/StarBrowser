import path from 'node:path'

export const UPDATE_REPOSITORY = 'aafqaq/StarBrowser'
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`

export const APP_COMPATIBILITY = Object.freeze({
  manifestVersion: 1,
  stateSchemaVersion: 1,
  storageSchemaVersion: 1,
  sessionExportFormatVersions: [1],
  sessionExportAlgorithmVersions: [1],
})

const legacyOwnedTopLevel = [
  'StarBrowser.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
  'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSE.electron.txt',
  'LICENSES.chromium.html', 'locales', 'resources', 'resources.pak', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
  'starbrowser-update.json',
]

function versionParts(version) {
  const clean = String(version || '').trim().replace(/^v/i, '').split('-')[0]
  if (!/^\d+(?:\.\d+){0,3}$/.test(clean)) return null
  return clean.split('.').map((value) => Number(value))
}

export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) throw new Error('版本号格式无效')
  for (let index = 0; index < Math.max(a.length, b.length, 3); index++) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference) return difference > 0 ? 1 : -1
  }
  return 0
}

export function safeVersion(version) {
  const normalized = String(version || '').trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) throw new Error('更新版本号无效')
  return normalized
}

function safeSha256(value) {
  const normalized = String(value || '').trim().replace(/^sha256:/i, '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('更新包缺少有效的 SHA-256 校验值')
  return normalized
}

export function normalizeOwnedTopLevel(entries, fallback = false) {
  const source = Array.isArray(entries) ? entries : fallback ? legacyOwnedTopLevel : []
  const safe = source
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry && entry.toLowerCase() !== 'data' && !entry.includes('/') && !entry.includes('\\') && entry !== '.' && entry !== '..')
  return [...new Set(safe)]
}

export function parseProgramManifest(candidate, fallback = false) {
  const manifest = candidate && typeof candidate === 'object' ? candidate : {}
  const ownedTopLevel = normalizeOwnedTopLevel(manifest.ownedTopLevel, fallback)
  if (!ownedTopLevel.includes('StarBrowser.exe') || !ownedTopLevel.includes('resources')) {
    throw new Error('更新包程序清单不完整')
  }
  return { manifestVersion: Number(manifest.manifestVersion) || 1, version: String(manifest.version || ''), ownedTopLevel }
}

export function parseReleaseCandidate(release, manifest, currentVersion, ignoredVersion = '') {
  if (!release || release.draft || release.prerelease) return null
  const version = safeVersion(manifest?.version || release.tag_name)
  if (compareVersions(version, currentVersion) <= 0 || version === ignoredVersion) return null
  const assets = Array.isArray(release.assets) ? release.assets : []
  const requestedName = String(manifest?.asset?.name || `StarBrowser-Windows-x64-v${version}.zip`)
  const asset = assets.find((item) => item?.name === requestedName)
  if (!asset?.browser_download_url) throw new Error('GitHub Release 中缺少 Windows 更新包')
  const sha256 = safeSha256(asset.digest || manifest?.asset?.sha256)
  const compatibility = manifest?.compatibility && typeof manifest.compatibility === 'object'
    ? manifest.compatibility
    : APP_COMPATIBILITY
  return {
    version,
    name: String(release.name || `StarBrowser v${version}`),
    notes: String(release.body || manifest?.notes || '本次更新包含体验优化与问题修复。').slice(0, 12_000),
    publishedAt: String(release.published_at || manifest?.publishedAt || ''),
    releaseUrl: String(release.html_url || `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`),
    asset: {
      name: requestedName,
      url: String(asset.browser_download_url),
      size: Math.max(0, Number(asset.size) || Number(manifest?.asset?.size) || 0),
      sha256,
    },
    compatibility,
  }
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function psArray(values) {
  return `@(${values.map(psLiteral).join(',')})`
}

export function buildApplyUpdatePowerShell({ targetRoot, payloadRoot, updatesRoot, mainPid, token, oldOwnedTopLevel, newOwnedTopLevel }) {
  const target = path.resolve(targetRoot)
  const payload = path.resolve(payloadRoot)
  const updates = path.resolve(updatesRoot)
  const data = path.join(target, 'data')
  if (!payload.toLowerCase().startsWith(`${updates.toLowerCase()}${path.sep}`)) throw new Error('更新负载不在安全临时目录中')
  if (!updates.toLowerCase().startsWith(`${data.toLowerCase()}${path.sep}`) && updates.toLowerCase() !== data.toLowerCase()) throw new Error('更新目录不在 data 中')
  const oldOwned = normalizeOwnedTopLevel(oldOwnedTopLevel, true)
  const newOwned = normalizeOwnedTopLevel(newOwnedTopLevel)
  if (!newOwned.includes('StarBrowser.exe') || !newOwned.includes('resources')) throw new Error('待安装文件清单不完整')
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = ${psLiteral(target)}
$payload = ${psLiteral(payload)}
$updates = ${psLiteral(updates)}
$data = ${psLiteral(data)}
$backup = Join-Path $updates 'rollback-program'
$safety = Join-Path $updates 'safety'
$health = Join-Path $updates ${psLiteral(`health-${token}.ok`)}
$handoff = Join-Path $updates ${psLiteral(`handoff-${token}.ready`)}
$failureLog = Join-Path $data 'update-error.log'
$cleanupLog = Join-Path $data 'update-cleanup-pending.log'
$progressFile = Join-Path $data 'update-progress.json'
$mainPid = ${Number(mainPid)}
$oldOwned = ${psArray(oldOwned)}
$newOwned = ${psArray(newOwned)}
$exe = Join-Path $target 'StarBrowser.exe'
$programChanged = $false

function Write-UpdateProgress([string]$phase, [int]$percent, [string]$message, [string]$detail = '') {
  try {
    [ordered]@{ phase = $phase; percent = $percent; message = $message; detail = $detail; updatedAt = [DateTime]::UtcNow.ToString('o') } |
      ConvertTo-Json -Compress | Set-Content -LiteralPath $progressFile -Encoding UTF8 -Force
  } catch { }
}

function Assert-SafeRoot {
  $targetFull = [IO.Path]::GetFullPath($target).TrimEnd('\')
  $dataFull = [IO.Path]::GetFullPath($data).TrimEnd('\')
  $updatesFull = [IO.Path]::GetFullPath($updates).TrimEnd('\')
  $payloadFull = [IO.Path]::GetFullPath($payload).TrimEnd('\')
  if ($dataFull -ne (Join-Path $targetFull 'data')) { throw 'data 路径校验失败' }
  if (-not $updatesFull.StartsWith($dataFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '更新目录越界' }
  if (-not $payloadFull.StartsWith($updatesFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '更新负载目录越界' }
  if (-not (Test-Path -LiteralPath (Join-Path $payloadFull 'StarBrowser.exe'))) { throw '更新负载缺少主程序' }
}

function Remove-Owned([string[]]$names) {
  foreach ($name in $names) {
    if ([string]::IsNullOrWhiteSpace($name) -or $name -eq 'data' -or $name.Contains('\') -or $name.Contains('/')) { continue }
    $item = Join-Path $target $name
    if (Test-Path -LiteralPath $item) { Invoke-WithRetry "删除 $name" { Remove-Item -LiteralPath $item -Recurse -Force -ErrorAction Stop } }
  }
}

function Invoke-WithRetry([string]$operation, [scriptblock]$action) {
  $lastError = $null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { & $action; return } catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
  }
  throw "$operation 失败：$($lastError.Exception.Message)"
}

function Restore-Program {
  Remove-Owned $newOwned
  if (Test-Path -LiteralPath $backup) {
    Get-ChildItem -LiteralPath $backup | ForEach-Object { $source = $_.FullName; Invoke-WithRetry "恢复 $($_.Name)" { Move-Item -LiteralPath $source -Destination $target -Force } }
  }
  if (Test-Path -LiteralPath $safety) {
    foreach ($name in @('state.json','state.backup.json','compatibility.json')) {
      $copy = Join-Path $safety $name
      if (Test-Path -LiteralPath $copy) { Copy-Item -LiteralPath $copy -Destination (Join-Path $data $name) -Force }
    }
  }
}

try {
  Assert-SafeRoot
  Write-UpdateProgress 'handoff' 5 '更新程序已接管，正在关闭 StarBrowser…'
  Set-Content -LiteralPath $handoff -Value ([DateTime]::UtcNow.ToString('o')) -Encoding ASCII -Force
  Write-UpdateProgress 'waiting' 12 '正在等待主程序安全退出…'
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    if (-not (Get-Process -Id $mainPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 200
  }
  if (Get-Process -Id $mainPid -ErrorAction SilentlyContinue) { throw '等待旧程序退出超时' }
  Start-Sleep -Milliseconds 600
  Write-UpdateProgress 'backup' 28 '正在备份当前程序，data 不会被覆盖…'
  if (Test-Path -LiteralPath $backup) { Invoke-WithRetry '清理旧回滚目录' { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop } }
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $programChanged = $true
  foreach ($name in $oldOwned) {
    if ([string]::IsNullOrWhiteSpace($name) -or $name -eq 'data' -or $name.Contains('\') -or $name.Contains('/')) { continue }
    $item = Join-Path $target $name
    if (Test-Path -LiteralPath $item) { Invoke-WithRetry "备份 $name" { Move-Item -LiteralPath $item -Destination $backup -Force -ErrorAction Stop } }
  }
  foreach ($name in $newOwned) {
    Write-UpdateProgress 'installing' 52 '正在安装新版程序文件…'
    $item = Join-Path $payload $name
    if (-not (Test-Path -LiteralPath $item)) { throw "更新负载缺少：$name" }
    Invoke-WithRetry "安装 $name" { Move-Item -LiteralPath $item -Destination $target -Force -ErrorAction Stop }
  }
  if (-not (Test-Path -LiteralPath $exe)) { throw '更新后主程序不存在' }
  if (Test-Path -LiteralPath $health) { Remove-Item -LiteralPath $health -Force }
  Write-UpdateProgress 'verifying' 76 '正在启动新版并执行健康检查…'
  Start-Process -FilePath $exe -WorkingDirectory $target -ArgumentList @(${psLiteral(`--post-update-token=${token}`)}, ${psLiteral(`--post-update-version=${path.basename(updates)}`)})
  for ($attempt = 0; $attempt -lt 300; $attempt++) {
    if (Test-Path -LiteralPath $health) { break }
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $health)) { throw '新版启动健康检查超时' }
  Write-UpdateProgress 'cleanup' 92 '新版运行正常，正在清理临时文件…'
  $cleanupDeferred = $false
  try {
    Invoke-WithRetry '清理更新临时目录' { Remove-Item -LiteralPath $updates -Recurse -Force -ErrorAction Stop }
    Remove-Item -LiteralPath $cleanupLog -Force -ErrorAction SilentlyContinue
  } catch {
    # The new version is already healthy. A transient antivirus/ASAR lock must
    # never roll a successful update back; the next startup removes this stage.
    Set-Content -LiteralPath $cleanupLog -Value "[$(Get-Date -Format o)] $($_.Exception.Message)" -Encoding UTF8
    $cleanupDeferred = $true
  }
  Remove-Item -LiteralPath $failureLog -Force -ErrorAction SilentlyContinue
  if ($cleanupDeferred) {
    Write-UpdateProgress 'success' 100 '更新成功，临时文件将在下次启动时清理。'
  } else {
    Write-UpdateProgress 'success' 100 '更新完成，StarBrowser 已重新启动。'
  }
} catch {
  $failureDetail = $_.Exception.Message
  $message = "[$(Get-Date -Format o)] $failureDetail"
  try {
    Set-Content -LiteralPath $failureLog -Value $message -Encoding UTF8
    if ($programChanged) {
      Get-CimInstance Win32_Process -Filter "Name='StarBrowser.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($exe, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep -Milliseconds 500
      Restore-Program
      if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe -WorkingDirectory $target }
    } elseif (-not (Get-Process -Id $mainPid -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $exe)) {
      Start-Process -FilePath $exe -WorkingDirectory $target
    }
    Write-UpdateProgress 'error' 100 '更新未能完成，当前版本和 data 已保留。' $failureDetail
  } catch {
    Add-Content -LiteralPath $failureLog -Value ([Environment]::NewLine + "回滚失败：$($_.Exception.Message)") -Encoding UTF8
    Write-UpdateProgress 'error' 100 '更新失败，请重新打开 StarBrowser 后重试。' $_.Exception.Message
  }
}
`
  return script.trimStart()
}

export function buildUpdateUiPowerShell({ workerScript, progressFile, failureFile, version }) {
  const worker = path.resolve(workerScript)
  const progress = path.resolve(progressFile)
  const failure = path.resolve(failureFile)
  const displayVersion = safeVersion(version)
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$worker = ${psLiteral(worker)}
$progressFile = ${psLiteral(progress)}
$failureFile = ${psLiteral(failure)}
$version = ${psLiteral(displayVersion)}

Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Title="StarBrowser 更新" Width="480" Height="258" ResizeMode="NoResize"
        WindowStartupLocation="CenterScreen" Background="#F8F9FC"
        FontFamily="Microsoft YaHei UI" ShowInTaskbar="True" Topmost="True">
  <Grid Margin="28,24,28,22">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>
    <TextBlock Name="TitleText" FontSize="20" FontWeight="SemiBold" Foreground="#202123" Text="正在更新 StarBrowser"/>
    <TextBlock Grid.Row="1" Margin="0,8,0,0" FontSize="12" Foreground="#7A8190" Text="程序会在安全替换完成后自动重新启动"/>
    <Grid Grid.Row="2" Margin="0,24,0,0" Height="10">
      <Border Background="#E6E8F0" CornerRadius="5"/>
      <Border Name="ProgressFill" Background="#625BF6" CornerRadius="5" HorizontalAlignment="Left" Width="0"/>
    </Grid>
    <StackPanel Grid.Row="3" Margin="0,18,0,0">
      <TextBlock Name="StatusText" FontSize="13" Foreground="#343842" Text="正在启动独立更新程序…" TextWrapping="Wrap"/>
      <TextBlock Name="DetailText" Margin="0,7,0,0" FontSize="11" Foreground="#C73E4D" TextWrapping="Wrap" MaxHeight="42"/>
    </StackPanel>
    <Grid Grid.Row="4">
      <TextBlock Name="PercentText" VerticalAlignment="Center" FontSize="12" Foreground="#8A90A0" Text="0%"/>
      <Button Name="CloseButton" HorizontalAlignment="Right" Width="82" Height="32" IsEnabled="False"
              Background="#625BF6" Foreground="White" BorderThickness="0" Content="关闭"/>
    </Grid>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$window.Title = "StarBrowser $version 更新"
$window.FindName('TitleText').Text = "正在安装 StarBrowser $version"
if ($env:STARBROWSER_UPDATER_UI_TEST -eq '1') {
  $window.ShowActivated = $false
  $window.ShowInTaskbar = $false
  $window.WindowState = 'Minimized'
}
$progressFill = $window.FindName('ProgressFill')
$statusText = $window.FindName('StatusText')
$detailText = $window.FindName('DetailText')
$percentText = $window.FindName('PercentText')
$closeButton = $window.FindName('CloseButton')
$script:working = $true
$script:successAt = $null
$script:workerProcess = $null

function Start-UpdateWorker {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = 'powershell.exe'
  $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $worker.Replace('"', '""') + '"'
  $start.WorkingDirectory = [IO.Path]::GetTempPath()
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $script:workerProcess = [Diagnostics.Process]::Start($start)
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(120)
$timer.Add_Tick({
  if (Test-Path -LiteralPath $progressFile) {
    try {
      $state = Get-Content -LiteralPath $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $percent = [Math]::Max(0, [Math]::Min(100, [int]$state.percent))
      $progressFill.Width = 4.24 * $percent
      $percentText.Text = "$percent%"
      $statusText.Text = [string]$state.message
      $detailText.Text = [string]$state.detail
      if ($state.phase -eq 'success') {
        $script:working = $false
        $closeButton.IsEnabled = $true
        $closeButton.Content = '完成'
        if ($null -eq $script:successAt) { $script:successAt = [DateTime]::UtcNow }
        if (([DateTime]::UtcNow - $script:successAt).TotalSeconds -ge 1.4) { $window.Close() }
      } elseif ($state.phase -eq 'error') {
        $script:working = $false
        $closeButton.IsEnabled = $true
        $closeButton.Content = '关闭'
      }
    } catch { }
  } elseif ($script:workerProcess -and $script:workerProcess.HasExited) {
    $script:working = $false
    $closeButton.IsEnabled = $true
    $statusText.Text = '更新程序意外退出，当前软件文件未被继续修改。'
    if (Test-Path -LiteralPath $failureFile) { $detailText.Text = Get-Content -LiteralPath $failureFile -Raw -Encoding UTF8 }
  }
})
$closeButton.Add_Click({ $window.Close() })
$window.Add_ContentRendered({
  try { Start-UpdateWorker } catch {
    $script:working = $false
    $statusText.Text = '无法启动更新程序。'
    $detailText.Text = $_.Exception.Message
    $closeButton.IsEnabled = $true
  }
  $timer.Start()
})
$window.Add_Closing({ if ($script:working) { $_.Cancel = $true } })
[void]$window.ShowDialog()
$timer.Stop()
if (-not $script:working -and (Test-Path -LiteralPath $progressFile)) {
  Remove-Item -LiteralPath $progressFile -Force -ErrorAction SilentlyContinue
}
`
  return script.trimStart()
}

export function legacyProgramManifest() {
  return { manifestVersion: 1, version: '', ownedTopLevel: [...legacyOwnedTopLevel] }
}
