# Mitwirken (Contributing)

## 1. Grundregel: Clean Room (verbindlich)

Dieses Projekt ist eine **eigene Implementierung** und **keine** abgeleitete Fassung eines anderen
Zeiterfassungssystems. Grundlage ist die **interne Spezifikation**: Sie liegt außerhalb dieses Repositories
und wird **nicht veröffentlicht**. Veröffentlicht werden ausschließlich die Adapter-Beschreibung
(`README.md`), diese Mitwirkungsregeln und der Quellcode (siehe Abschnitt 6).

**Unzulässig**

- Code, Kommentare, Meldungstexte, Klassen- oder Variablennamen aus fremden Projekten übernehmen –
  auch nicht „kopieren und umbenennen".
- Fremdcode automatisch portieren oder übersetzen (Transpiler, LLM-Konvertierung).
- Die Datei- oder Klassenstruktur fremder Projekte als eigene Modulstruktur nachbauen.

**Zulässig**

(`users.txt`, `userdaten.txt` Idx 0–17, `Timetable/<Jahr>.<Monat>`, `A<Jahr>`, `absenz.txt`).

- Berechnungsregeln, Verhalten und Rundungsregeln (dokumentiert in der internen Spezifikation).
- Kurze technische Bezeichner in der Dokumentation zur Nachvollziehbarkeit.

**Eigene Bezeichner im Code** (englisch, konsistent):
`_Vorholzeit_pro_Jahr` → `vorholzeit_per_year`, `_zuschlag` → `shift_rules`, `Timetable` → `time_entries`,
`_modell` → `overtimeModel`, `absenz.txt` → `absenceTypes`.

## 2. Arbeitsweise

1. **Spec-first:** Verhalten zuerst in der **internen Spezifikation** festhalten (sie liegt außerhalb
   dieses Repositories und wird nicht veröffentlicht).
2. **Tests vor Implementierung:** Golden-Files und Fixtures aus **beobachteten Ausgaben** der
   Referenzinstallation bzw. aus den Bestandsdaten erzeugen – niemals aus fremdem Code ableiten.
3. **Implementieren** und die Spezifikation bei Abweichungen anpassen – nicht fremden Code als
   Referenz nachschlagen, um eine Implementierung „passend" zu machen.
4. Spezifikationsänderungen werden im selben Arbeitsgang wie der Code gepflegt und im PR-Text kurz
   erwähnt (die Spezifikation selbst wird nicht veröffentlicht).

## 3. PR-Checkliste

- [ ] Kein Code, Kommentar oder Bezeichner aus einem fremden Projekt übernommen (Abgleich gegen die
      Spezifikation, Ergebnis im PR genannt).
- [ ] Interne Spezifikation aktualisiert, falls Verhalten/Format betroffen ist (im PR-Text erwähnt).
- [ ] Tests ergänzt bzw. angepasst (Unit/Integration; Golden-File bei Berechnungslogik).
- [ ] i18n: neue Texte nur in `en.json` ergänzt, `npm run translate` ausgeführt, `npm run check:i18n` grün
      (alle 11 Sprachen vollständig).
- [ ] Lizenz- und Herkunftshinweise unverändert korrekt (`LICENSE`, Abschnitt „Provenance" in `README.md`).
- [ ] Keine Fremddateien, Archive oder Datenkopien im Commit (`*.zip`, fremde Verzeichnisse).
- [ ] Neue/geänderte States: `common.role`, `common.type`, `common.read`, `common.write` passen zusammen —
      keine generische Rolle `state`, `button` → `boolean` mit `read:false`/`write:true`, Rolle `json` →
      `common.type = "string"`.
- [ ] Neue Texte in `common.news` der aktuellen Version in **allen 11 Sprachen** ergänzt (der Adapter-Checker
      meldet fehlende Übersetzungen der neuesten Version als Fehler).
- [ ] Secrets ausschließlich über `encryptedNative`/`protectedNative`; kein Klartext in `native` oder in Logs.
- [ ] Adapter-Checker-Ergebnis im PR genannt, sobald das Adaptergerüst existiert (`npx @iobroker/repochecker <repo-url> --local`).

## 4. Code-Konventionen

- **TypeScript** (strict), ESLint mit `@iobroker/eslint-config`, Prettier; keine deutschen Bezeichner
  im Code (Ausnahme: fachliche Begriffe, die bewusst so dokumentiert sind, z. B. `vorholzeit_per_year`).
- **Adapter-Tests:** `@iobroker/testing` — `tests.packageFiles` (prüft `package.json`/`io-package.json`) und
  `tests.integration` gegen einen js-controller; die mitgelieferten Unit-Mocks sind deprecated.
- **Eigene Logik:** Mocha mit ts-node und chai für Berechnungs- und Zeitzonen-Fälle (`test/mocharc.custom.json`),
  Playwright für E2E der PWA, `npm run coverage` (`nyc`) für die Abdeckung — der Coverage-Lauf verzichtet bewusst auf
  die Typprüfung (`test/mocharc.coverage.json`), weil typprüfendes ts-node unter `nyc` an den Adapter-Typen scheitert;
  `npm run check` bleibt das Typgate;
  Testnamen beschreiben Szenario und Erwartung („baut Paare nach (ts_utc, id)", nicht „test1").
- **Web-App (`src-www/`):** eigenes Projekt mit eigenem `package.json`/`tsconfig.json` (React 18, MUI 5, Vite).
  Ablauf: `npm run install:pwa` → `npm run build:pwa` (Typprüfung + Build nach `www/`) → `npm run lint:pwa`;
  während der Entwicklung `npm run dev:pwa` (leitet `/api` auf die laufende Instanz). Die App spricht
  ausschließlich über das API-Präfix `/api` mit dem Adapter, hält die Sitzung in `localStorage` und legt
  Stempel offline in eine Warteschlange (`idempotencyKey` je Stempel). Berechtigungen entscheidet **immer** der
  Server; die UI blendet nur aus, was ohnehin verboten wäre. Neue Texte gehören in `src-www/src/i18n/en.json`.
- **Generiertes:** `build/` und `www/` werden erzeugt und nie direkt bearbeitet.
- **States:** Objekte über `setObjectNotExistsAsync`/`extendObject` anlegen; `common.name` (mindestens `en`+`de`),
  `common.type`, `common.role`, `common.read`, `common.write` sind Pflicht und müssen zu den Rollenregeln passen
  (siehe PR-Checkliste).
- **Konfiguration:** Secrets gehören in `encryptedNative`/`protectedNative`; der `native`-Block,
  `admin/jsonConfig.json` und `src/lib/adapter-config.d.ts` werden synchron gehalten.
- **Zeiten:** intern immer UTC-Epoch **und** Minuten-Ganzzahlen; Anzeige über Benutzer-Zeitzone.
- **Datenbank:** Änderungen ausschließlich über versionierte Migrationen (`schema_migrations`).
- **Fehler:** API-Fehler als `application/problem+json` mit stabilen Fehlercodes (gemäß interner Spezifikation).
- **Sprachen (i18n):** Anzeigetexte ausschließlich aus den Sprachdateien; neue Texte **nur** in der englischen
  Basisdatei ergänzen und danach `npm run translate` ausführen. Details: [`docs/i18n.md`](docs/i18n.md).
- **Commits:** kurze, sachliche Beschreibung im Imperativ; ein Commit pro logischer Änderung.
- **Integrationstest:** Er läuft gegen das **gebaute** Paket (`npm pack` aus `build/`). Vor
  `npm run test:integration` deshalb immer `npm run build` ausführen — sonst prüft der Test stillschweigend den
  vorherigen Stand (sichtbar daran, dass neue Log-Ausgaben im Testlauf fehlen).
- **Zeilenenden und Formatierung:** Zeilenenden sind **LF** (`.gitattributes`, `.editorconfig`, Prettier);
  CRLF lässt `npm run lint` mit hunderten `prettier/prettier`-Fehlern scheitern. Formatierung deshalb mit
  `npx prettier --write "src/**/*.ts"` korrigieren und **nicht** mit `eslint --fix`: `--fix` ergänzt für
  undokumentierte Member leere JSDoc-Blöcke und erzeugt damit Fehler (`jsdoc/no-blank-blocks`).

## 5. Sicherheitsrelevante Änderungen

Betroffen sind insbesondere Authentifizierung, Session-/Token-Handling, RBAC, Audit und
Terminal-Endpunkte. Solche Änderungen benötigen: Beschreibung des Risikos, Test der Negativfälle
(Rechte, CSRF, Idempotenz, `409`) und Aktualisierung der Sicherheitscheckliste in der internen
Spezifikation.

## 6. Was veröffentlicht wird

| Dokument                              | Ort                                                 | Veröffentlicht                |
| ------------------------------------- | --------------------------------------------------- | ----------------------------- |
| Adapter-Beschreibung                  | `README.md` (später zusätzlich `adapter/README.md`) | ja                            |
| Lizenz                                | `LICENSE`                                           | ja                            |
| Mitwirkungsregeln (Clean Room)        | `CONTRIBUTING.md`                                   | ja                            |
| Herkunft                              | Abschnitt „Provenance" in `README.md`               | ja                            |
| Quellcode                             | `src/`, `src-www/`, `src-shared/`, `tools/`         | ja                            |
| Sprachdateien (11 Sprachen)           | `admin/i18n/`, `src-www/src/i18n/`                  | ja (Übersetzungen willkommen) |
| Übersetzer-Doku                       | `docs/i18n.md`                                      | ja                            |
| Interne Spezifikation                 | außerhalb dieses Repositories                       | **nein**                      |
| Fremde Projekte, Archive, Datenkopien | außerhalb dieses Repositories                       | **nein**                      |

Regeln dazu:

- Die interne Spezifikation wird **nie** in das Repository kopiert; `.gitignore` enthält dafür ein
  Sicherheitsnetz (`PROJECT_PROMPT.md`, `docs/PROJECT_PROMPT.md`).
- Referenzen auf Abschnittsnummern der Spezifikation gehören nicht in veröffentlichte Dateien wie
  `README.md`; interne Modul-READMEs beschreiben die Vorgaben in eigenen Worten.
- Der Herkunftsnachweis wird außerhalb dieses Repositories geführt und nennt die Grundlage der Umsetzung
  sowie die Feststellung „kein fremder Quellcode übernommen".

### Release-Ablauf

1. `npm run version:bump patch` setzt die Version in `package.json`, `io-package.json` und im Changelog des README.
   Die News-Einträge danach in **allen 11 Sprachen** nachtragen — der Bump kopiert nur die erste Zeile.
2. `npm run version:check` (prüft auch, dass die Listen nicht wachsen: höchstens sieben `common.news`-Einträge und
   fünf Versionen im README), `npm run check:i18n`, `npm test`, `npm run check:adapter` und `npm run e2e` (letzteres
   **nach** `npm run build && npm run build:pwa`, sonst prüft es einen alten Stand) müssen grün sein — erst dann
   committen. Nach Skript-gestützten Änderungen immer `npm run lint` laufen lassen: eslint wertet Prettier-Regeln
   als Fehler, und ein einzelner zu langer Ausdruck lässt den CI-Job `check-and-lint` scheitern. `lint` und
   `lint:pwa` laufen mit `--max-warnings 0`, eine Warnung ist also genauso ein Fehler wie ein Fehler.
3. **Vor dem Commit und dem Push fragen.** Der Versions-Commit und das Tag gehen nur raus, wenn der Auftraggeber
   (Alex) „ok" sagt: unmittelbar vor dem Release wird gefragt, ob gepusht werden darf oder ob es noch Anmerkungen
   gibt. Erst nach diesem „ok" wird committet, getaggt und gepusht.
4. Commit, **annotiertes** Tag (`git tag -a vX.Y.Z -m 'X.Y.Z'`) und Push mit Freigabe (`npm run push:approve`).
   Die Commit-Nachricht des Versions-Commits wird zur **Release-Notiz** — der Workflow schreibt ihren Body auf die
   Release-Seite. Sie wird deshalb **auf Englisch** geschrieben (wie die Changelog-Einträge im README), damit die
   Release-Seite für alle lesbar ist.
5. **Warten, bis der Workflow „Test and Release" für das Tag grün ist — und danach weitere 5 bis 10 Minuten:**
   die Veröffentlichung auf npm läuft am Ende des Laufs und der Registry-Index zieht nach (gemessen: grüner Lauf
   17:37, `npm view … dist-tags` zeigt die Version 17:42). Erst dann prüfen.
6. Ein Tag einer veröffentlichten Version wird **nie gelöscht und neu gepusht**. Das löscht das zugehörige
   GitHub-Release, erzeugt einen roten Lauf (npm lehnt eine zweite Veröffentlichung derselben Version ab) und
   ändert am veröffentlichten Paket nichts. Fehlt ein Tag, wird nur das Tag neu gesetzt und das Release in der
   GitHub-Oberfläche daraus erstellt.

## 7. Lokaler Dev-Server (ioBroker dev-server)

Die Entwicklungsinstanz liegt in `.dev-server/`: Admin auf `http://127.0.0.1:8081`, der Adapter mit der
Weboberfläche auf `http://127.0.0.1:8092`. Gestartet wird sie mit

```powershell
npm run dev-server watch
```

Der Dev-Server baut den Adapter, installiert ihn in die Dev-Instanz (`npm pack` + `npm install`) und startet ihn
selbst; bei jeder Quelländerung startet er ihn nach rund zwei Sekunden neu.

Regeln, in dieser Reihenfolge wichtig:

1. **Die Instanz bleibt im Controller deaktiviert.** Der Dev-Server startet den Adapter selbst, der Controller darf
   ihn nicht zusätzlich starten — sonst läuft jede Controller-seitige Startanfrage in `ADAPTER_ALREADY_RUNNING`
   (Code 7) und wiederholt sich im 30-Sekunden-Takt. Prüfen und setzen (aus `.dev-server/default`):

    ```powershell
    node node_modules/iobroker.js-controller/iobroker.js list instances
    node node_modules/iobroker.js-controller/iobroker.js object set system.adapter.time-tracker.0 common.enabled=false
    ```

    Im Log steht dann `Do not restart adapter system.adapter.time-tracker.0 because disabled or deleted`, und der
    Adapter läuft weiter, weil der Dev-Server ihn hält.

2. **Den Adapter nie in `ioBroker.admin` starten oder neu starten**, solange `dev-server watch` läuft — ein Start
   aus der Oberfläche aktiviert die Instanz wieder und erzeugt genau die Schleife aus Regel 1. Im Log sieht das so
   aus: `"system.adapter.time-tracker.0" enabled` → `started with pid …` → `terminated with code 7
(ADAPTER_ALREADY_RUNNING)` → `Restart adapter … because enabled`, alle 30 Sekunden. Die Doku des Dev-Servers
   weist ausdrücklich darauf hin. Einen Neustart erzwingt man, indem man eine Quelldatei speichert (der Watcher
   übernimmt) oder die ganze Kette neu startet.
3. Wer den Adapter **aus der Admin-Oberfläche** starten und stoppen können will, wählt einen der beiden Modi — dann
   hält nur eine Seite den Adapter und ein Start/Stopp in der Oberfläche ist unproblematisch:
    - `npm run dev-server run` — der Dev-Server startet den Adapter nicht, der Controller hält ihn. Hot-Reload gibt
      es nur für die Admin-Oberfläche; Codeänderungen brauchen `npm run build` und (bei gestopptem Dev-Server)
      `npm run dev-server upload`.
    - `npm run dev-server watch --noStart` — der Dev-Server baut und synchronisiert weiterhin automatisch, startet
      den Adapter aber nicht. Er deaktiviert die Instanz bei jedem eigenen Start (`adapter.common.enabled = false`,
      im Log `Stop <adapter>.0`), deshalb den Adapter danach **einmal** starten — in der Admin-Oberfläche oder mit
      `node .dev-server/default/node_modules/iobroker.js-controller/iobroker.js start time-tracker.0`.
      Danach hält der Controller ihn; Start, Stopp und Neustart in der Oberfläche sind unproblematisch. Nach einer
      Codeänderung den Adapter dort neu starten, damit die synchronisierte Fassung geladen wird.
4. **Nur ein Dev-Server gleichzeitig** und **kein zusätzliches `npm run build`** daneben: der Dev-Server baut
   selbst, parallele Builds führen zu Race-Conditions und Folge-Restarts.
5. Hängt die Instanz doch in der Schleife, alle Prozesse beenden, deren Kommandozeilentext das Repository oder
   `.dev-server` nennt, und `npm run dev-server watch --noStart` neu starten.
6. Die Playwright-Suite (`npm run e2e`) startet einen eigenen Server auf Port `8099` mit In-Memory-Datenbank
   und lässt den Dev-Server unberührt; sie lädt den Adapter aus `build/`, weshalb vorher `npm run build` nötig ist.
7. Für den Aufruf `--no-browser-sync` mitgeben: BrowserSync ist schon beim Start einmal an einem Race mit dem noch
   startenden Admin gescheitert (`ECONNREFUSED 127.0.0.1:20426`) und hat den Dev-Server mitgerissen. Der Preis ist
   nur, dass Änderungen an der ioBroker-Admin-Oberfläche nicht mehr automatisch nachgeladen werden.

Die Daten der Dev-Instanz liegen unter `.dev-server/default/iobroker-data/time-tracker.0/` (Datenbank,
`session-secret`, `backups/`) und werden nicht versioniert.

## 8. Versionierung und Release

Die Version des Adapters steht an **zwei** Stellen und muss immer gleich sein: `package.json` (`version`) und
`io-package.json` (`common.version`). Die Prüfung dafür läuft in `npm run test:package` und zusätzlich über
`npm run version:check`.

Regeln:

1. **Nichts wird ohne Freigabe gepusht oder veröffentlicht.** Vor einem `git push` und vor jedem Versionssprung
   (`npm run release …`) wird der Maintainer gefragt und die Antwort abgewartet. Wer den Push sperren möchte,
   schaltet die Freigabepflicht in seiner Arbeitskopie ein (lokale Einstellung, nicht versioniert):

    ```powershell
    git config zt.requirePushApproval true   # wirkt nur zusammen mit core.hooksPath = .githooks
    npm run push:approve                     # zeigt die offenen Commits und gibt genau diesen Commit frei
    git push                                 # jetzt erlaubt — der nächste Commit braucht wieder ein OK
    ```

    Ohne Freigabe bricht der Pre-Push-Hook ab; dauerhaft ausschalten mit
    `git config zt.requirePushApproval false`.

2. **Vor jedem Push hebt `npm run version:bump -- patch` die Version an** (oder `minor`/`major`). Das Werkzeug setzt
   beide Versionsfelder, benennt den Block „WORK IN PROGRESS" im README auf die neue Version um, legt einen frischen
   Platzhalter an und ergänzt `common.news` für die neue Version. Danach die News übersetzen (`npm run translate` oder
   von Hand) und `npm run version:check`, `npm run check:i18n` sowie die Tests laufen lassen. Die Argumente gehören
   hinter `--`, sonst verschluckt npm sie (`npm run version:bump -- patch --dry` zeigt den Ablauf ohne zu schreiben).

3. **Jede Änderung bekommt vor dem Push ihren Eintrag** im Changelog des README (`## Changelog`, neuester
   Abschnitt `### **WORK IN PROGRESS**`). Dieser Block darf **nicht leer** sein — das Release-Werkzeug lehnt das ab.
   Die Version wird dabei **nicht** von Hand geändert.
4. **Der Changelog steht im README, nicht in einer eigenen Datei.** Das Release-Werkzeug liest `CHANGELOG.md` nur,
   wenn es existiert, und würde den README-Abschnitt dann nicht mehr pflegen. Im README bleiben die letzten **fünf**
   Versionen (`--numChangelogEntries`, Standard 5); ältere wandern nach `CHANGELOG_OLD.md`, sobald diese Datei
   existiert. Dann muss im README ein Fußzeilen-Link auf `CHANGELOG_OLD.md` stehen bleiben (das Werkzeug verlangt
   ihn).
5. **Veröffentlicht wird über einen Tag.** Der Tag markiert die Version, die in der CI gebaut und über
   **npm trusted publishing** veröffentlicht wird (ohne diese Freigabe in npm scheitert der Deploy-Job):

    ```powershell
    git tag v0.0.2                   # die freigegebene Version markieren
    npm run push:approve             # Freigabe fuer den Tag-Push
    git push --follow-tags           # Tag pushen — die CI veroeffentlicht das Paket
    ```

    `npm run release <patch|minor|major>` bleibt als Alternative verfuegbar: es hebt die Version an, schreibt
    Changelog und `common.news` und taggt in einem Zug (siehe `.releaseconfig.json`, dort laeuft vorher
    `npm run build`).

    **Beide Bauausgaben gehören ins Paket.** Der Deploy-Job baut vor dem Veröffentlichen `build/` **und** `www/`
    (eigener `build-command`, weil `build/` und `www/` nicht im Repository liegen); `npm run check:package` —
    über `prepack` automatisch vor `npm pack` und `npm publish` — lässt den Release scheitern, wenn eine davon
    fehlt. Die Veröffentlichungen bis 0.0.6 enthielten kein `www/` und antworteten auf `/` mit `404 not_found`.

6. Nach jedem Versionssprung die `common.news`-Texte in allen 11 Sprachen prüfen bzw. `npm run translate` laufen lassen —
   der Adapterchecker verlangt sie (Regel E510). `npm run check:i18n` meldet Lücken.
7. **Der Pre-Push-Hook** prüft Punkt 1 und 2 automatisch. Einmalig je Arbeitskopie aktivieren:

    ```powershell
    npm run hooks:install
    ```

    Er bricht den Push ab, wenn keine Freigabe für den Commit vorliegt, die Versionsfelder auseinanderlaufen, der README-Changelog fehlt oder sein neueste
    Abschnitt weder „WORK IN PROGRESS" noch die aktuelle Version ist. Bewusst übergehen: `git push --no-verify`.
