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
$failureLog = Join-Path $data 'update-error.log'
$mainPid = ${Number(mainPid)}
$oldOwned = ${psArray(oldOwned)}
$newOwned = ${psArray(newOwned)}
$exe = Join-Path $target 'StarBrowser.exe'

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
    if (Test-Path -LiteralPath $item) { Remove-Item -LiteralPath $item -Recurse -Force -ErrorAction Stop }
  }
}

function Restore-Program {
  Remove-Owned $newOwned
  if (Test-Path -LiteralPath $backup) {
    Get-ChildItem -LiteralPath $backup | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $target -Force }
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
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    if (-not (Get-Process -Id $mainPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 200
  }
  if (Get-Process -Id $mainPid -ErrorAction SilentlyContinue) { throw '等待旧程序退出超时' }
  Start-Sleep -Milliseconds 600
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  foreach ($name in $oldOwned) {
    if ([string]::IsNullOrWhiteSpace($name) -or $name -eq 'data' -or $name.Contains('\') -or $name.Contains('/')) { continue }
    $item = Join-Path $target $name
    if (Test-Path -LiteralPath $item) { Move-Item -LiteralPath $item -Destination $backup -Force }
  }
  foreach ($name in $newOwned) {
    $item = Join-Path $payload $name
    if (-not (Test-Path -LiteralPath $item)) { throw "更新负载缺少：$name" }
    Move-Item -LiteralPath $item -Destination $target -Force
  }
  if (-not (Test-Path -LiteralPath $exe)) { throw '更新后主程序不存在' }
  if (Test-Path -LiteralPath $health) { Remove-Item -LiteralPath $health -Force }
  Start-Process -FilePath $exe -WorkingDirectory $target -ArgumentList @(${psLiteral(`--post-update-token=${token}`)}, ${psLiteral(`--post-update-version=${path.basename(updates)}`)})
  for ($attempt = 0; $attempt -lt 300; $attempt++) {
    if (Test-Path -LiteralPath $health) { break }
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $health)) { throw '新版启动健康检查超时' }
  Remove-Item -LiteralPath $updates -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $failureLog -Force -ErrorAction SilentlyContinue
} catch {
  $message = "[$(Get-Date -Format o)] $($_.Exception.Message)"
  try {
    Get-CimInstance Win32_Process -Filter "Name='StarBrowser.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($exe, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Restore-Program
    Set-Content -LiteralPath $failureLog -Value $message -Encoding UTF8
    if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe -WorkingDirectory $target }
  } catch {
    Add-Content -LiteralPath $failureLog -Value ([Environment]::NewLine + "回滚失败：$($_.Exception.Message)") -Encoding UTF8
  }
}
`
  return script.trimStart()
}

export function legacyProgramManifest() {
  return { manifestVersion: 1, version: '', ownedTopLevel: [...legacyOwnedTopLevel] }
}
