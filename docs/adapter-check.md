# Adapter-Konformität prüfen

Zwei Stufen: `npm run check:adapter` (lokal, offline) und der offizielle Checker
(`npx @iobroker/repochecker`), sobald das Repository auf GitHub liegt.

## 1. Lokale Vorprüfung (offline)

```powershell
npm run check:adapter
```

`tools/check-adapter.ps1` prüft die Regeln des offiziellen Checkers, die sich **ohne** GitHub auswerten
lassen, und nennt jeweils die Kennung der Regel:

| Regel | Prüft |
| --- | --- |
| W0066/S0067 | `@types/node` deckt die Mindest-Node-Version aus `package.json` → `engines.node` ab |
| (tsconfig) | `@tsconfig/nodeNN` passt zur Mindest-Node-Version |
| (generate-adapter) | `.create-adapter.json` → `nodeVersion` passt zu `engines.node` |
| W5052/W5053 | jedes `"type": "password"` in `admin/jsonConfig.json` steht in `protectedNative` **und** `encryptedNative` |
| E5049/E5050 | kein `process.env`/`process.exit` im Quellcode, solange `common.compact` nicht `true` ist |
| W8918 | keine ioBroker-Workflow-Action ohne Versions-Tag (`@main`/`@master`) |
| W6021 | `## License` ist der **letzte** Abschnitt von `README.md` |
| E510 | `common.news` der neuesten Version enthält alle 11 Sprachen |
| W438 | `.vscode/settings.json` enthält `json.schemas` |

Exit-Code 1 (mit `-FailOnIssue`) bei Fehlern; Warnungen und Hinweise lassen den Lauf durch.

Nicht in dieser Stufe enthalten, weil der Checker dafür die **Dateiliste des Repositorys** und die
**Projekt-Einstellungen** von GitHub liest: veröffentlichte Versionsnummern, Release-Notizen,
`package-lock.json` gegen `engines.node`, Dependabot-Konfiguration, Lizenzdatei-Abgleich, Actions-Rechte
und die Struktur der `objects`/`instanceObjects`. Deshalb bleibt die zweite Stufe verbindlich.

Button-States (`role: "button"` mit `read: false`, `write: true`) prüft der Checker strukturell; im Projekt
übernehmen das die Unit-Tests in `src/lib/adapter/states.test.ts`.

## 2. Offizieller Checker (mit veröffentlichtem Repository)

Der Checker liest immer Projektdaten über die GitHub-API und bricht ohne Repository mit
`[E0000] FATAL: cannot access repository https://api.github.com/repos/…` ab — lokal allein mit `--local`
funktioniert er daher nicht. Sobald `https://github.com/sadam6752-tech/ioBroker.zeiterfassung` existiert:

```powershell
npx @iobroker/repochecker@latest https://github.com/sadam6752-tech/ioBroker.zeiterfassung --local
```

`--local` liest dabei die Dateien aus dem Arbeitsverzeichnis (also den lokalen Stand statt des gepushten),
die Repository-Metadaten kommen weiterhin von GitHub. Für höhere GitHub-Rate-Limits kann ein Token über
`--env <datei>` mit `GITHUB_TOKEN=…` übergeben werden.

## Bewusste Abweichungen

* `common.compact: false` — der Adapter bindet einen eigenen HTTP-Port und hält eine SQLite-Datei
  (`WAL`) über die gesamte Laufzeit; er läuft deshalb bewusst als eigener Prozess. Der lokale Check
  meldet das als **Hinweis**, der offizielle Checker als Warnung (`W5049`).
* Kein `process.env`/`process.exit` im Quellcode: Konfiguration kommt ausschließlich aus
  `adapter.config`, das Beenden übernimmt der Adapter-Lifecycle. Damit ist die Anforderung erfüllt,
  die der Checker sonst an den Compact-Mode stellt.
