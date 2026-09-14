# Mitwirken (Contributing)

## 1. Grundregel: Clean Room (verbindlich)

Dieses Projekt ist eine **eigene Implementierung** und **keine** abgeleitete Fassung des Referenzsystems
SMALL-Time (AGPL-3.0). Grundlage ist die **interne Spezifikation**: Sie liegt außerhalb dieses Repositories
und wird **nicht veröffentlicht**. Veröffentlicht werden ausschließlich die Adapter-Beschreibung
(`README.md`), der Herkunftsnachweis (`docs/provenance.md`), diese Mitwirkungsregeln und der Quellcode
(siehe Abschnitt 6).

**Unzulässig**
- Code, Kommentare, Meldungstexte, Klassen- oder Variablennamen aus `SmallTime-master` übernehmen –
  auch nicht „kopieren und umbenennen".
- Legacy-Dateien automatisch portieren oder übersetzen (Transpiler, LLM-Konvertierung).
- Die Legacy-Datei- oder Klassenstruktur als eigene Modulstruktur nachbauen.

**Zulässig**
- Dateinamen, Dateiformate und Feldindizes der Altdaten, soweit sie zum Lesen nötig sind
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
   Referenzinstallation bzw. aus den Bestandsdaten erzeugen – niemals aus dem Legacy-Code ableiten.
3. **Implementieren** und die Spezifikation bei Abweichungen anpassen – nicht den Legacy-Code als
   Referenz nachschlagen, um eine Implementierung „passend" zu machen.
4. Spezifikationsänderungen werden im selben Arbeitsgang wie der Code gepflegt und im PR-Text kurz
   erwähnt (die Spezifikation selbst wird nicht veröffentlicht).

## 3. PR-Checkliste

- [ ] Kein Code/Kommentar/Bezeichner aus dem Legacy-Baum übernommen (Clean-Room-Prüfung gelaufen:
      `npm run cleanroom`, Ergebnis im PR genannt).
- [ ] Interne Spezifikation aktualisiert, falls Verhalten/Format betroffen ist (im PR-Text erwähnt).
- [ ] Tests ergänzt bzw. angepasst (Unit/Integration; Golden-File bei Berechnungslogik).
- [ ] i18n: neue Texte nur in `en.json` ergänzt, `npm run translate` ausgeführt, `npm run check:i18n` grün
      (alle 11 Sprachen vollständig).
- [ ] Lizenz- und Herkunftshinweise unverändert korrekt (`LICENSE`, `docs/provenance.md`).
- [ ] Keine Legacy-Dateien, Archive oder Datenkopien im Commit (`SmallTime-master/`, `*.zip`).

## 4. Code-Konventionen

- **TypeScript** (strict), ESLint mit `@iobroker/eslint-config`, Prettier; keine deutschen Bezeichner
  im Code (Ausnahme: fachliche Begriffe, die bewusst so dokumentiert sind, z. B. `vorholzeit_per_year`).
- **Adapter-Tests:** `@iobroker/testing` — `tests.packageFiles` (prüft `package.json`/`io-package.json`) und
  `tests.integration` gegen einen js-controller; die mitgelieferten Unit-Mocks sind deprecated.
- **Eigene Logik:** Vitest für Berechnung, Import-Parser und Zeitzonen-Fälle, Playwright für E2E der PWA;
  Testnamen beschreiben Szenario und Erwartung („baut Paare nach (ts_utc, id)", nicht „test1").
- **Generiertes:** `build/` und `www/` werden erzeugt und nie direkt bearbeitet.
- **Zeiten:** intern immer UTC-Epoch **und** Minuten-Ganzzahlen; Anzeige über Benutzer-Zeitzone.
- **Datenbank:** Änderungen ausschließlich über versionierte Migrationen (`schema_migrations`).
- **Fehler:** API-Fehler als `application/problem+json` mit stabilen Fehlercodes (gemäß interner Spezifikation).
- **Sprachen (i18n):** Anzeigetexte ausschließlich aus den Sprachdateien; neue Texte **nur** in der englischen
  Basisdatei ergänzen und danach `npm run translate` ausführen. Details: [`docs/i18n.md`](docs/i18n.md).
- **Commits:** kurze, sachliche Beschreibung im Imperativ; ein Commit pro logischer Änderung.

## 5. Sicherheitsrelevante Änderungen

Betroffen sind insbesondere Authentifizierung, Session-/Token-Handling, RBAC, Audit, Import und
Terminal-Endpunkte. Solche Änderungen benötigen: Beschreibung des Risikos, Test der Negativfälle
(Rechte, CSRF, Idempotenz, `409`) und Aktualisierung der Sicherheitscheckliste in der internen
Spezifikation.

## 6. Was veröffentlicht wird

| Dokument | Ort | Veröffentlicht |
|---|---|---|
| Adapter-Beschreibung | `README.md` (später zusätzlich `adapter/README.md`) | ja |
| Lizenz | `LICENSE` | ja |
| Mitwirkungsregeln (Clean Room) | `CONTRIBUTING.md` | ja |
| Herkunftsnachweis | `docs/provenance.md` | ja (belegt die unabhängige Umsetzung) |
| Quellcode | `adapter/`, `pwa/`, `shared/`, `tools/` | ja |
| Sprachdateien (11 Sprachen) | `adapter/admin/i18n/`, `pwa/src/i18n/` | ja (Übersetzungen willkommen) |
| Übersetzer-Doku | `docs/i18n.md` | ja |
| Interne Spezifikation | außerhalb dieses Repositories | **nein** |
| Prüfbericht | `docs/cleanroom-report.txt` | nein (generiert, `.gitignore`) |
| Legacy-Baum, Archive, Bestandsdaten | außerhalb dieses Repositories | **nein** |

Regeln dazu:

- Die interne Spezifikation wird **nie** in das Repository kopiert; `.gitignore` enthält dafür ein
  Sicherheitsnetz (`PROJECT_PROMPT.md`, `docs/PROJECT_PROMPT.md`).
- Referenzen auf Abschnittsnummern der Spezifikation gehören nicht in veröffentlichte Dateien wie
  `README.md`; interne Modul-READMEs beschreiben die Vorgaben in eigenen Worten.
- Der Herkunftsnachweis bleibt öffentlich und nennt das Referenzsystem samt Lizenz (AGPL-3.0) sowie die
  Feststellung „kein Quellcode übernommen".
