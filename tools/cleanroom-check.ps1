<#
.SYNOPSIS
    Clean-Room-Prüfung des Projekts (Umsetzung der Clean-Room-Regel, siehe CONTRIBUTING.md, Abschnitt 1).

.DESCRIPTION
    Sammelt Kommentar- und Stringfragmente aus dem Legacy-Projekt (SMALL-Time, AGPL-3.0) und sucht
    wörtliche Übernahmen in den eigenen Quellen. Ein Treffer ist ein PRÜFFALL, kein Beweis:
    technische Bezeichner und Formatangaben sind zulässig, kopierter Code und kopierte Kommentare nicht.

    Exit-Codes:
      0 = keine Treffer (oder noch keine eigenen Quellen vorhanden)
      1 = Treffer gefunden (nur mit -FailOnHit)
      2 = Fehler (Legacy-Baum nicht gefunden)

.PARAMETER LegacyPath
    Wurzel des Legacy-Baums. Standard: ..\..\SmallTime-master (also neben dem app-Ordner).

.PARAMETER SourcePaths
    Eigene Ordner oder Dateien (relativ zum Arbeitsverzeichnis).
    Standard: adapter, pwa, shared, lib, src, docs, tools, README.md, CONTRIBUTING.md
    Hinweis: Referenz-/Testdaten (Legacy-Baum, `fixtures/`) werden bewusst nicht geprüft.

.PARAMETER MinLength
    Minimale Fragmentlänge in Zeichen (filtert Allerweltskürzel heraus). Standard: 25

.PARAMETER ReportPath
    Zieldatei des Berichts. Standard: docs\cleanroom-report.txt

.PARAMETER MaxHitsShown
    Anzahl der im Konsolenbericht ausgegebenen Treffer. Standard: 20

.PARAMETER FailOnHit
    Exit-Code 1, wenn Treffer existieren (für CI).

.EXAMPLE
    pwsh -NoProfile -File tools/cleanroom-check.ps1

.EXAMPLE
    pwsh -NoProfile -File tools/cleanroom-check.ps1 -LegacyPath ../SmallTime-master -SourcePaths adapter,pwa,shared -FailOnHit
#>
[CmdletBinding()]
param(
    [string]   $LegacyPath   = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..', '..', 'SmallTime-master')),
    [string[]] $SourcePaths  = @('adapter', 'pwa', 'shared', 'lib', 'src', 'docs', 'tools', 'README.md', 'CONTRIBUTING.md'),
    [int]      $MinLength    = 25,
    [string]   $ReportPath   = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..', 'docs', 'cleanroom-report.txt')),
    [int]      $MaxHitsShown = 20,
    [switch]   $FailOnHit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:LegacyExtensions    = @('*.php', '*.js', '*.css')
$script:SourceExtensions    = @('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
                                '.md', '.css', '.scss', '.html', '.sql', '.yml', '.yaml')
$script:ExcludedDirectories = @('node_modules', '.git', 'dist', 'build', 'out', 'coverage',
                                '.cache', 'tmp', '.vite')
$script:MaxSourceFileSize   = 2097152   # 2 MiB

function Get-LegacyFragments {
    <# Sammelt normalisierte Kommentar- und Stringfragmente aus dem Legacy-Baum. #>
    param([string] $Root, [int] $MinLength)

    $fragments = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

    foreach ($file in (Get-ChildItem -LiteralPath $Root -Recurse -File -Include $script:LegacyExtensions)) {
        foreach ($line in (Get-Content -LiteralPath $file.FullName -Encoding UTF8)) {
            $candidates = [System.Collections.Generic.List[string]]::new()

            if ($line -match '//(.*)$')         { [void]$candidates.Add($Matches[1]) }
            if ($line -match '^\s*\*(.*)$')     { [void]$candidates.Add($Matches[1]) }
            if ($line -match '^\s*/\*(.*)$')    { [void]$candidates.Add($Matches[1]) }
            foreach ($m in [regex]::Matches($line, "'([^']{4,})'")) { [void]$candidates.Add($m.Groups[1].Value) }
            foreach ($m in [regex]::Matches($line, '"([^"]{4,})"')) { [void]$candidates.Add($m.Groups[1].Value) }

            foreach ($candidate in $candidates) {
                $normalized = ($candidate -replace '\s+', ' ').Trim()
                if ($normalized.Length -ge $MinLength) { [void]$fragments.Add($normalized) }
            }
        }
    }

    return ,$fragments
}

function Get-SourceFiles {
    <# Liefert die eigenen Quelldateien zu den angegebenen Pfaden. #>
    param([string[]] $Paths, [string[]] $Extensions, [string[]] $ExcludedDirectories, [int] $MaxSize)

    $files = [System.Collections.Generic.List[object]]::new()

    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path)) { continue }

        $item = Get-Item -LiteralPath $path
        if ($item.PSIsContainer) {
            $candidates = @(Get-ChildItem -LiteralPath $path -Recurse -File)
        }
        else {
            $candidates = @($item)
        }

        foreach ($candidate in $candidates) {
            if ($candidate.Length -gt $MaxSize) { continue }
            if ($Extensions -notcontains $candidate.Extension.ToLowerInvariant()) { continue }

            $excluded = $false
            foreach ($dir in $ExcludedDirectories) {
                if ($candidate.FullName -match "[\\/]$([regex]::Escape($dir))[\\/]") { $excluded = $true; break }
            }
            if (-not $excluded) { [void]$files.Add($candidate) }
        }
    }

    return ,$files
}

# --- Legacy-Baum prüfen -------------------------------------------------------
if (-not (Test-Path -LiteralPath $LegacyPath)) {
    Write-Host "FEHLER: Legacy-Baum nicht gefunden: $LegacyPath" -ForegroundColor Red
    Write-Host "Hinweis: Pfad mit -LegacyPath angeben (Wurzel des SmallTime-Baums)."
    exit 2
}
$legacyRoot = (Resolve-Path -LiteralPath $LegacyPath).Path

# --- eigene Quellen sammeln ---------------------------------------------------
$sourceFiles = Get-SourceFiles -Paths $SourcePaths -Extensions $script:SourceExtensions `
                              -ExcludedDirectories $script:ExcludedDirectories `
                              -MaxSize $script:MaxSourceFileSize

Write-Host 'Clean-Room-Prüfung (Regel siehe CONTRIBUTING.md, Abschnitt 1)'
Write-Host "  Legacy-Baum:       $legacyRoot"
Write-Host "  Eigene Quellen:    $($sourceFiles.Count) Datei(en) aus: $($SourcePaths -join ', ')"
Write-Host "  Minimal-Länge:     $MinLength Zeichen"

$fragments = Get-LegacyFragments -Root $legacyRoot -MinLength $MinLength
Write-Host "  Legacy-Fragmente:  $($fragments.Count)"

if ($sourceFiles.Count -eq 0) {
    Write-Host ''
    Write-Host 'KEINE eigenen Quelldateien gefunden – es gibt derzeit nichts zu prüfen.' -ForegroundColor Yellow
    Write-Host 'Sobald Quellcode existiert: -SourcePaths prüfen (Standard adapter,pwa,shared,lib,src).'
    exit 0
}

$contents = @{}
foreach ($file in $sourceFiles) {
    $contents[$file.FullName] = (Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8)
}
$blob = ($contents.Values -join "`n")

$hits = [System.Collections.Generic.List[object]]::new()
foreach ($fragment in $fragments) {
    if (-not $blob.Contains($fragment)) { continue }

    foreach ($entry in $contents.GetEnumerator()) {
        if (-not $entry.Value.Contains($fragment)) { continue }

        $index = $entry.Value.IndexOf($fragment)
        $line  = ($entry.Value.Substring(0, $index) -split "`n").Count
        $path = $entry.Key
        $cwd  = (Get-Location).Path
        if ($path.StartsWith($cwd, [System.StringComparison]::OrdinalIgnoreCase)) {
            $path = $path.Substring($cwd.Length).TrimStart('\', '/')
        }
        [void]$hits.Add([pscustomobject]@{ File = $path; Line = $line; Fragment = $fragment })
    }
}

# --- Bericht schreiben --------------------------------------------------------
$reportLines = [System.Collections.Generic.List[string]]::new()
[void]$reportLines.Add('Clean-Room-Bericht (Regel siehe CONTRIBUTING.md, Abschnitt 1)')
[void]$reportLines.Add('')
[void]$reportLines.Add("Datum:               $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
[void]$reportLines.Add("Legacy-Baum:         $legacyRoot")
[void]$reportLines.Add("Eigene Quellen:      $($sourceFiles.Count) Datei(en) aus: $($SourcePaths -join ', ')")
[void]$reportLines.Add("Fragment-Mindestl.:  $MinLength Zeichen")
[void]$reportLines.Add("Legacy-Fragmente:    $($fragments.Count)")
[void]$reportLines.Add("Treffer:             $($hits.Count)")
[void]$reportLines.Add('')
if ($hits.Count -eq 0) {
    [void]$reportLines.Add('Ergebnis: keine wörtlichen Übernahmen gefunden (Heuristik).')
}
else {
    [void]$reportLines.Add('Ergebnis: PRÜFFÄLLE – bitte bewerten (technischer Bezeichner zulässig, Kopie nicht):')
    foreach ($hit in $hits) {
        [void]$reportLines.Add("  - $($hit.File):$($hit.Line): $($hit.Fragment)")
    }
}

$reportDir = Split-Path -Parent $ReportPath
if ($reportDir -and -not (Test-Path -LiteralPath $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
$reportLines | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "  Bericht:           $((Resolve-Path -LiteralPath $ReportPath).Path)"

# --- Ergebnis -----------------------------------------------------------------
Write-Host ''
if ($hits.Count -eq 0) {
    Write-Host 'ERGEBNIS: keine wörtlichen Übernahmen gefunden.' -ForegroundColor Green
}
else {
    Write-Host "ERGEBNIS: $($hits.Count) Prüffall/Prüffälle." -ForegroundColor Yellow
    $shown = 0
    foreach ($hit in $hits) {
        if ($shown -ge $MaxHitsShown) { Write-Host '  ... weitere Einträge im Bericht.'; break }
        Write-Host ("  {0}:{1}: {2}" -f $hit.File, $hit.Line, $hit.Fragment)
        $shown++
    }
    Write-Host ''
    Write-Host 'Bewertung: technische Bezeichner und Formate sind zulässig – Code und Kommentare nicht.' -ForegroundColor Yellow
    Write-Host 'Ergebnis zusätzlich in docs/provenance.md dokumentieren.'
}

if ($hits.Count -gt 0 -and $FailOnHit) { exit 1 }
exit 0
