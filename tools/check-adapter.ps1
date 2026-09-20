<#
.SYNOPSIS
    Lokale Adapter-Konformitätsprüfung (Vorprüfung für den ioBroker-Adapter-Checker).

.DESCRIPTION
    Der offizielle Checker (`npx @iobroker/repochecker <repo> --local`) liest Projekt-Einstellungen
    grundsätzlich über die GitHub-API; ohne veröffentlichtes Repository bricht er mit E0000 ab
    (siehe docs/adapter-check.md). Dieses Skript prüft deshalb die Regeln, die sich rein lokal
    auswerten lassen, und nennt die Kennung der jeweiligen Checker-Regel:

      W0066/S0067  @types/node passt nicht zur Mindest-Node-Version aus package.json/engines
      (neu)        @tsconfig/nodeNN passt nicht zur Mindest-Node-Version
      W5052/W5053  Passwortfeld in admin/jsonConfig.json fehlt in protectedNative/encryptedNative
      E5049/E5050  process.env/process.exit im Quellcode ohne common.compact = true
      W8918        ioBroker-Workflow-Action ohne Versions-Tag (@main/@master)
      W6021        "## License" ist nicht der letzte Abschnitt in README.md
      W510/E510    common.news der neuesten Version ohne alle Sprachschlüssel
      W438         .vscode/settings.json ohne json.schemas
      (neu)        .create-adapter.json nodeVersion weicht von engines.node ab

    Button-States (role "button" mit read:false/write:true) prüft der Checker strukturell; im Projekt
    übernehmen das die Unit-Tests in src/lib/adapter/states.test.ts.

    Exit-Codes:
      0 = keine Fehler (Warnungen und Hinweise erlaubt)
      1 = Fehler gefunden (nur mit -FailOnIssue)
      2 = Fehler bei der Prüfung selbst (fehlende Dateien)

.PARAMETER FailOnIssue
    Exit-Code 1, wenn Fehler gefunden wurden (für CI).

.EXAMPLE
    pwsh -NoProfile -File tools/check-adapter.ps1

.EXAMPLE
    pwsh -NoProfile -File tools/check-adapter.ps1 -FailOnIssue
#>
[CmdletBinding()]
param(
    [switch] $FailOnIssue
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($PSScriptRoot, '..'))
$script:Problems = [System.Collections.Generic.List[object]]::new()
$script:Languages = @('en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn')

function Add-Issue {
    <# Merkt sich einen Befund. #>
    param(
        [ValidateSet('error', 'warn', 'info')] [string] $Level,
        [string] $Rule,
        [string] $Message
    )
    [void]$script:Problems.Add([pscustomobject]@{ Level = $Level; Rule = $Rule; Message = $Message })
}

function Read-Json {
    <# Liest eine JSON-Datei relativ zum Repository. #>
    param([string] $RelativePath)
    $file = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    return (Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json)
}

Write-Host 'Lokale Adapter-Konformitätsprüfung (Vorprüfung für @iobroker/repochecker)' -ForegroundColor Cyan
Write-Host "  Repository: $root"
Write-Host ''

$package = Read-Json 'package.json'
$ioPackage = Read-Json 'io-package.json'
if (-not $package -or -not $ioPackage) {
    Write-Host 'FEHLER: package.json oder io-package.json nicht gefunden.' -ForegroundColor Red
    exit 2
}

# --- Node-Version, Typen und tsconfig ----------------------------------------
$engineRange = [string] $package.engines.node
if ($engineRange -notmatch '(\d+)') {
    Add-Issue error 'W0066' "engines.node '$engineRange' enthält keine Major-Version"
}
else {
    $engineMajor = [int] $Matches[1]
    Write-Host "  Node-Mindestversion: $engineMajor (engines.node $engineRange)"

    $typesNode = [string] $package.devDependencies.'@types/node'
    if ($typesNode -match '(\d+)') {
        $typesMajor = [int] $Matches[1]
        if ($typesMajor -lt $engineMajor) {
            Add-Issue error 'W0066/S0067' "@types/node ($typesNode) deckt nur Node $typesMajor ab, engines.node verlangt >= $engineMajor"
        }
        elseif ($typesMajor -eq $engineMajor) {
            Write-Host "  @types/node: $typesNode (passt)"
        }
        else {
            Write-Host "  @types/node: $typesNode (höher als die Mindestversion, zulässig)"
        }
    }

    $tsconfig = Join-Path $root 'tsconfig.json'
    if (Test-Path -LiteralPath $tsconfig) {
        $raw = Get-Content -LiteralPath $tsconfig -Raw -Encoding UTF8
        if ($raw -match '@tsconfig/node(\d+)') {
            $tsMajor = [int] $Matches[1]
            if ($tsMajor -ne $engineMajor) {
                Add-Issue error 'tsconfig' "@tsconfig/node$tsMajor passt nicht zu engines.node >= $engineMajor"
            }
            else {
                Write-Host "  tsconfig: @tsconfig/node$tsMajor"
            }
        }
    }

    $createAdapter = Read-Json '.create-adapter.json'
    if ($createAdapter -and [string] $createAdapter.nodeVersion -and ([string] $createAdapter.nodeVersion) -ne [string] $engineMajor) {
        Add-Issue warn 'generate-adapter' ".create-adapter.json nodeVersion '$($createAdapter.nodeVersion)' weicht von engines.node >= $engineMajor ab"
    }
}

# --- Geheimnisse im Admin-Formular -------------------------------------------
$jsonConfigPath = Join-Path $root 'admin/jsonConfig.json'
$passwordFields = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $jsonConfigPath) {
    $config = Get-Content -LiteralPath $jsonConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    # Breitensuche: jedes Element kennt den Schlüssel, unter dem es im Formular steht
    $pending = [System.Collections.Generic.Queue[object]]::new()
    $pending.Enqueue([pscustomobject]@{ Key = ''; Value = $config })
    while ($pending.Count -gt 0) {
        $item = $pending.Dequeue()
        $value = $item.Value
        if ($value -is [System.Collections.IDictionary]) {
            if ($value['type'] -eq 'password' -and $item.Key) {
                [void]$passwordFields.Add([string] $item.Key)
            }
            foreach ($key in $value.Keys) {
                $child = $value[$key]
                if ($child -is [System.Collections.IDictionary] -or ($child -is [System.Collections.IEnumerable] -and $child -isnot [string])) {
                    $pending.Enqueue([pscustomobject]@{ Key = [string] $key; Value = $child })
                }
            }
        }
        elseif ($value -is [System.Collections.IEnumerable] -and $value -isnot [string]) {
            foreach ($entry in $value) {
                if ($entry -is [System.Collections.IDictionary] -or ($entry -is [System.Collections.IEnumerable] -and $entry -isnot [string])) {
                    $pending.Enqueue([pscustomobject]@{ Key = $item.Key; Value = $entry })
                }
            }
        }
    }
}

$protected = @()
if ($ioPackage.PSObject.Properties.Name -contains 'protectedNative') { $protected = @($ioPackage.protectedNative) }
$encrypted = @()
if ($ioPackage.PSObject.Properties.Name -contains 'encryptedNative') { $encrypted = @($ioPackage.encryptedNative) }
if ($passwordFields.Count -eq 0) {
    Write-Host '  Admin-Formular: keine Passwortfelder gefunden'
}
else {
    foreach ($field in $passwordFields) {
        if ($protected -notcontains $field) { Add-Issue error 'W5052' "Passwortfeld '$field' fehlt in common.protectedNative" }
        if ($encrypted -notcontains $field) { Add-Issue error 'W5053' "Passwortfeld '$field' fehlt in common.encryptedNative" }
    }
    Write-Host "  Admin-Formular: $($passwordFields.Count) Passwortfeld(er), native-Schutz: $($protected -join ', ')"
}

# --- Compact-Mode und verbotene Prozess-Aufrufe ------------------------------
$compact = $null
if ($ioPackage.common.PSObject.Properties.Name -contains 'compact') { $compact = $ioPackage.common.compact }
if ($compact -eq $true) {
    Write-Host '  common.compact: true'
}
elseif ($compact -eq $false) {
    Add-Issue info 'W5049' 'common.compact ist bewusst false (eigener HTTP-Port und SQLite-Datei, kein Compact-Mode)'
}
else {
    Add-Issue warn 'W5049' 'common.compact fehlt – der Checker empfiehlt eine ausdrückliche Angabe'
}

$processHits = [System.Collections.Generic.List[string]]::new()
foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $root 'src') -Recurse -File -Include '*.ts' -ErrorAction SilentlyContinue)) {
    $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
    if ($content -match 'process\.(env|exit)\b') {
        $relative = $file.FullName.Substring($root.Length).TrimStart('\', '/')
        [void]$processHits.Add($relative)
    }
}
if ($processHits.Count -gt 0 -and $compact -ne $true) {
    Add-Issue error 'E5049/E5050' "process.env/process.exit in: $($processHits -join ', ') – ohne common.compact = true nicht zulässig"
}
elseif ($processHits.Count -eq 0) {
    Write-Host '  Quellcode: kein process.env/process.exit'
}

# --- Workflow-Actions mit Versions-Tag ---------------------------------------
$workflowDir = Join-Path $root '.github/workflows'
if (Test-Path -LiteralPath $workflowDir) {
    $workflows = Get-ChildItem -LiteralPath $workflowDir -File -Include '*.yml', '*.yaml'
    $badRefs = [System.Collections.Generic.List[string]]::new()
    foreach ($workflow in $workflows) {
        $lines = Get-Content -LiteralPath $workflow.FullName -Encoding UTF8
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match 'uses:\s*(iobroker|ioBroker|iobroker-community-adapters|iobroker-bot-orga)/[^\s@]+@(main|master)\b') {
                [void]$badRefs.Add("$($workflow.Name):$($i + 1): $($Matches[0].Trim())")
            }
        }
    }
    if ($badRefs.Count -gt 0) {
        foreach ($ref in $badRefs) { Add-Issue error 'W8918' "Action ohne Versions-Tag: $ref" }
    }
    else {
        Write-Host "  Workflows: $($workflows.Count) Datei(en), alle Actions mit Versions-Tag"
    }
}

# --- README-Abschnitte -------------------------------------------------------
$readmePath = Join-Path $root 'README.md'
if (Test-Path -LiteralPath $readmePath) {
    $headings = (Get-Content -LiteralPath $readmePath -Encoding UTF8 | Where-Object { $_ -match '^##\s+\S' })
    $last = if ($headings.Count -gt 0) { $headings[$headings.Count - 1] } else { '' }
    if ($last -notmatch '^##\s+License') {
        Add-Issue error 'W6021' "der letzte Abschnitt in README.md ist '$last', erwartet wird '## License'"
    }
    else {
        Write-Host '  README: "## License" ist der letzte Abschnitt'
    }
    if (-not ($headings | Where-Object { $_ -match '^##\s+Changelog' })) {
        Add-Issue warn 'README' 'README.md hat keinen Abschnitt "## Changelog"'
    }
}
else {
    Add-Issue error 'README' 'README.md fehlt'
}

# --- common.news der neuesten Version ---------------------------------------
$news = $null
if ($ioPackage.common.PSObject.Properties.Name -contains 'news') { $news = $ioPackage.common.news }
if (-not $news) {
    Add-Issue error 'E510' 'common.news fehlt in io-package.json'
}
else {
    $newest = @($news.PSObject.Properties.Name) | Select-Object -First 1
    $missing = [System.Collections.Generic.List[string]]::new()
    foreach ($language in $script:Languages) {
        $entry = $news.$newest
        if (-not $entry -or -not $entry.$language) { [void]$missing.Add($language) }
    }
    if ($missing.Count -gt 0) {
        Add-Issue error 'E510' "common.news.$newest fehlen die Sprachen: $($missing -join ', ')"
    }
    else {
        Write-Host "  common.news.$newest : alle $($script:Languages.Count) Sprachen vorhanden"
    }
}

# --- VS-Code-Schemas ---------------------------------------------------------
$vscodeSettings = Join-Path $root '.vscode/settings.json'
if (Test-Path -LiteralPath $vscodeSettings) {
    $raw = Get-Content -LiteralPath $vscodeSettings -Raw -Encoding UTF8
    if ($raw -notmatch 'json\.schemas') {
        Add-Issue info 'W438' '.vscode/settings.json hat kein json.schemas für io-package.json/jsonConfig'
    }
    else {
        Write-Host '  .vscode/settings.json: json.schemas vorhanden'
    }
}

# --- Ergebnis -----------------------------------------------------------------
$errors = @($script:Problems | Where-Object { $_.Level -eq 'error' })
$warnings = @($script:Problems | Where-Object { $_.Level -eq 'warn' })
$infos = @($script:Problems | Where-Object { $_.Level -eq 'info' })

Write-Host ''
foreach ($issue in $script:Problems) {
    $color = switch ($issue.Level) { 'error' { 'Red' } 'warn' { 'Yellow' } default { 'DarkGray' } }
    $label = switch ($issue.Level) { 'error' { 'FEHLER' } 'warn' { 'WARNUNG' } default { 'HINWEIS' } }
    Write-Host ("  {0,-7} [{1}] {2}" -f $label, $issue.Rule, $issue.Message) -ForegroundColor $color
}

Write-Host ''
Write-Host "Geprüft: $($script:Problems.Count) Befund(e) – $($errors.Count) Fehler, $($warnings.Count) Warnung(en), $($infos.Count) Hinweis(e)"
if ($errors.Count -eq 0) {
    Write-Host 'ERGEBNIS: keine Fehler in den lokal prüfbaren Adapter-Regeln.' -ForegroundColor Green
    Write-Host 'Hinweis: der vollständige Checker benötigt ein veröffentlichtes GitHub-Repository:'
    Write-Host '  npx @iobroker/repochecker https://github.com/sadam6752-tech/ioBroker.time-tracker --local'
}
else {
    Write-Host "ERGEBNIS: $($errors.Count) Fehler – siehe Liste oben." -ForegroundColor Red
}

if ($errors.Count -gt 0 -and $FailOnIssue) { exit 1 }
exit 0
