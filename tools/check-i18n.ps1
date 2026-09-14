<#
.SYNOPSIS
    i18n-Vollständigkeitsprüfung für die 11 ioBroker-Sprachen.

.DESCRIPTION
    Prüft:
      * alle Sprachdateien vorhanden (Adapter: adapter/admin/i18n/<lang>.json, PWA: pwa/src/i18n/<lang>.json)
      * identische Schlüsselmengen gegenüber der Basis (en)
      * io-package.json enthält alle Sprachschlüssel in common.titleLang, common.desc und common.news
    Noch nicht vorhandene Komponenten (z. B. vor Phase 1) werden übersprungen und gemeldet.

    Exit-Codes:
      0 = keine Befunde (oder nichts zu prüfen)
      1 = Befunde gefunden (nur mit -FailOnIssue)
      2 = Fehler (Repository nicht gefunden)

.PARAMETER RepoPath
    Wurzel des Repositories. Standard: übergeordneter Ordner dieses Skripts.

.PARAMETER Languages
    Erwartete Sprachcodes. Standard: en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn

.PARAMETER ReportPath
    Zieldatei des Berichts. Standard: docs/i18n-report.txt

.PARAMETER FailOnIssue
    Exit-Code 1, wenn Befunde existieren (für CI).

.EXAMPLE
    pwsh -NoProfile -File tools/check-i18n.ps1 -FailOnIssue

.EXAMPLE
    pwsh -NoProfile -File tools/check-i18n.ps1 -Languages en,de,ru -RepoPath C:\src\ioBroker.zeiterfassung
#>
[CmdletBinding()]
param(
    [string]   $RepoPath   = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..')),
    [string[]] $Languages  = @('en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'),
    [string]   $ReportPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..', 'docs', 'i18n-report.txt')),
    [switch]   $FailOnIssue
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-JsonObject {
    <# Liest eine JSON-Datei als Hashtable (oder $null, wenn die Datei fehlt/leer ist). #>
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ($null -eq $text -or $text.Trim() -eq '') { return $null }

    try { return ($text | ConvertFrom-Json -AsHashtable) }
    catch { throw "Ungültiges JSON in '$Path': $($_.Exception.Message)" }
}

function Get-FlattenedKeys {
    <# Liefert alle Schlüsselpfade eines JSON-Objekts in Punktnotation. #>
    param($Node, [string] $Prefix = '')

    $keys = [System.Collections.Generic.List[string]]::new()
    if ($null -eq $Node) { return ,$keys }

    if ($Node -is [System.Collections.IDictionary]) {
        foreach ($key in $Node.Keys) {
            $path = if ($Prefix) { "$Prefix.$key" } else { [string]$key }
            [void]$keys.Add($path)
            foreach ($child in (Get-FlattenedKeys -Node $Node[$key] -Prefix $path)) { [void]$keys.Add($child) }
        }
    }

    return ,$keys
}

# --- Repository prüfen --------------------------------------------------------
if (-not (Test-Path -LiteralPath $RepoPath)) {
    Write-Host "FEHLER: Repository nicht gefunden: $RepoPath" -ForegroundColor Red
    Write-Host 'Hinweis: Pfad mit -RepoPath angeben.'
    exit 2
}
$root = (Resolve-Path -LiteralPath $RepoPath).Path

$baseLanguage = 'en'
$issues = [System.Collections.Generic.List[string]]::new()
$notes  = [System.Collections.Generic.List[string]]::new()
$checkedSomething = $false

Write-Host 'i18n-Vollständigkeitsprüfung (11 Sprachen, siehe docs/i18n.md)'
Write-Host "  Repository:      $root"
Write-Host "  Sprachen:        $($Languages -join ', ')"

# --- Sprachdateien je Komponente ---------------------------------------------
$components = @(
    [pscustomobject]@{
        Name = 'Adapter-Admin'
        Dir  = [System.IO.Path]::Combine($root, 'adapter', 'admin', 'i18n')
    },
    [pscustomobject]@{
        Name = 'PWA'
        Dir  = [System.IO.Path]::Combine($root, 'pwa', 'src', 'i18n')
    }
)

foreach ($component in $components) {
    if (-not (Test-Path -LiteralPath $component.Dir)) {
        [void]$notes.Add("$($component.Name): Ordner fehlt ($($component.Dir)) – noch nicht implementiert, übersprungen")
        continue
    }

    $baseFile = [System.IO.Path]::Combine($component.Dir, "$baseLanguage.json")
    if (-not (Test-Path -LiteralPath $baseFile)) {
        [void]$issues.Add("$($component.Name): Basisdatei $baseLanguage.json fehlt")
        continue
    }

    $baseKeys = Get-FlattenedKeys -Node (Get-JsonObject -Path $baseFile)
    $checkedSomething = $true
    [void]$notes.Add("$($component.Name): Basis $baseLanguage.json mit $($baseKeys.Count) Schlüssel(n)")

    foreach ($language in $Languages) {
        if ($language -eq $baseLanguage) { continue }

        $file = [System.IO.Path]::Combine($component.Dir, "$language.json")
        if (-not (Test-Path -LiteralPath $file)) {
            [void]$issues.Add("$($component.Name): Sprachdatei $language.json fehlt")
            continue
        }

        $keys    = Get-FlattenedKeys -Node (Get-JsonObject -Path $file)
        $missing = @($baseKeys | Where-Object { $keys -notcontains $_ })
        $extra   = @($keys | Where-Object { $baseKeys -notcontains $_ })

        if ($missing.Count -gt 0) {
            [void]$issues.Add("$($component.Name) [$language]: $($missing.Count) fehlende(r) Schlüssel – z. B. $((@($missing | Select-Object -First 5)) -join ', ')")
        }
        if ($extra.Count -gt 0) {
            [void]$issues.Add("$($component.Name) [$language]: $($extra.Count) zusätzliche(r) Schlüssel – z. B. $((@($extra | Select-Object -First 5)) -join ', ')")
        }
    }
}

# --- io-package.json (Metadaten) ---------------------------------------------
$ioPackagePath = [System.IO.Path]::Combine($root, 'adapter', 'io-package.json')

if (-not (Test-Path -LiteralPath $ioPackagePath)) {
    [void]$notes.Add('Metadaten: adapter/io-package.json fehlt – noch nicht implementiert, übersprungen')
}
else {
    $ioPackage = Get-JsonObject -Path $ioPackagePath

    if ($null -eq $ioPackage) {
        [void]$issues.Add('Metadaten: adapter/io-package.json ist leer oder unlesbar')
    }
    else {
        $checkedSomething = $true
        $common = $ioPackage['common']

        foreach ($field in @('titleLang', 'desc')) {
            if ($null -eq $common -or -not $common.Contains($field)) {
                [void]$issues.Add("Metadaten: common.$field fehlt")
                continue
            }

            $keys    = Get-FlattenedKeys -Node $common[$field]
            $missing = @($Languages | Where-Object { $keys -notcontains $_ })
            if ($missing.Count -gt 0) {
                [void]$issues.Add("Metadaten: common.$field ohne Sprachschlüssel: $($missing -join ', ')")
            }
        }

        if ($null -eq $common -or -not $common.Contains('news')) {
            [void]$issues.Add('Metadaten: common.news fehlt')
        }
        else {
            foreach ($version in $common['news'].Keys) {
                $keys    = Get-FlattenedKeys -Node $common['news'][$version]
                $missing = @($Languages | Where-Object { $keys -notcontains $_ })
                if ($missing.Count -gt 0) {
                    [void]$issues.Add("Metadaten: common.news['$version'] ohne Sprachschlüssel: $($missing -join ', ')")
                }
            }
        }
    }
}

# --- Bericht ------------------------------------------------------------------
$reportLines = [System.Collections.Generic.List[string]]::new()
[void]$reportLines.Add('i18n-Bericht (11 Sprachen, siehe docs/i18n.md)')
[void]$reportLines.Add('')
[void]$reportLines.Add("Datum:        $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
[void]$reportLines.Add("Repository:   $root")
[void]$reportLines.Add("Sprachen:     $($Languages -join ', ')")
[void]$reportLines.Add("Befunde:      $($issues.Count)")
[void]$reportLines.Add('')
[void]$reportLines.Add('Hinweise:')
foreach ($note in $notes) { [void]$reportLines.Add("  - $note") }
[void]$reportLines.Add('')
if ($issues.Count -eq 0) {
    if ($checkedSomething) {
        [void]$reportLines.Add('Ergebnis: alle geprüften Sprachdateien und Metadaten sind vollständig.')
    }
    else {
        [void]$reportLines.Add('Ergebnis: nichts zu prüfen – es sind noch keine Sprachdateien oder Metadaten vorhanden.')
    }
}
else {
    [void]$reportLines.Add('Ergebnis: BEFUNDE – bitte beheben (npm run translate bzw. Texte ergänzen):')
    foreach ($issue in $issues) { [void]$reportLines.Add("  - $issue") }
}

$reportDir = Split-Path -Parent $ReportPath
if ($reportDir -and -not (Test-Path -LiteralPath $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
$reportLines | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "  Bericht:         $((Resolve-Path -LiteralPath $ReportPath).Path)"

# --- Ergebnis -----------------------------------------------------------------
Write-Host ''
foreach ($note in $notes) { Write-Host "  info: $note" }

if ($issues.Count -eq 0) {
    if ($checkedSomething) {
        Write-Host 'ERGEBNIS: Sprachdateien und Metadaten vollständig.' -ForegroundColor Green
    }
    else {
        Write-Host 'ERGEBNIS: nichts zu prüfen – noch keine Sprachdateien oder Metadaten vorhanden.' -ForegroundColor DarkGray
    }
}
else {
    Write-Host "ERGEBNIS: $($issues.Count) Befund(e):" -ForegroundColor Yellow
    foreach ($issue in $issues) { Write-Host "  - $issue" }
    Write-Host ''
    Write-Host 'Behebung: neue Texte nur in en.json ergänzen, dann "npm run translate" ausführen.' -ForegroundColor Yellow
}

if ($issues.Count -gt 0 -and $FailOnIssue) { exit 1 }
exit 0
