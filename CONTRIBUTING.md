# Mitwirken (Contributing)

## 1. Grundregel: Clean Room (verbindlich)

Dieses Projekt ist eine **eigene Implementierung** nach der Spezifikation in
[`../PROJECT_PROMPT.md`](../PROJECT_PROMPT.md) (Abschnitte 2.9, 3, 11) und **keine** abgeleitete
Fassung des Referenzsystems SMALL-Time (AGPL-3.0). Verbindlich ist Abschnitt 12.5 des Projektprompts.

**Unzulässig**
- Code, Kommentare, Meldungstexte, Klassen- oder Variablennamen aus `SmallTime-master` übernehmen –
  auch nicht „kopieren und umbenennen".
- Legacy-Dateien automatisch portieren oder übersetzen (Transpiler, LLM-Konvertierung).
- Die Legacy-Datei- oder Klassenstruktur als eigene Modulstruktur nachbauen.

**Zulässig**
- Dateinamen, Dateiformate und Feldindizes der Altdaten, soweit sie zum Lesen nötig sind
  (`users.txt`, `userdaten.txt` Idx 0–17, `Timetable/<Jahr>.<Monat>`, `A<Jahr>`, `absenz.txt`).
- Berechnungsregeln, Verhalten und Rundungsregeln (dokumentiert in der Spezifikation).
- Kurze technische Bezeichner in der Dokumentation zur Nachvollziehbarkeit.

**Eigene Bezeichner im Code** (englisch, konsistent):
`_Vorholzeit_pro_Jahr` → `vorholzeit_per_year`, `_zuschlag` → `shift_rules`, `Timetable` → `time_entries`,
`_modell` → `overtimeModel`, `absenz.txt` → `absenceTypes`.

## 2. Arbeitsweise

1. **Spec-first:** Verhalten zuerst in `PROJECT_PROMPT.md` beschreiben (Abschnitt 2.9/3 erweitern).
2. **Tests vor Implementierung:** Golden-Files und Fixtures aus **beobachteten Ausgaben** der
   Referenzinstallation bzw. aus den Bestandsdaten erzeugen – niemals aus dem Legacy-Code ableiten.
3. **Implementieren** und die Spezifikation bei Abweichungen anpassen – nicht den Legacy-Code als
   Referenz nachschlagen, um eine Implementierung „passend" zu machen.
4. Änderungen, die die Spezifikation betreffen, gehören in denselben PR wie der Code.

## 3. PR-Checkliste

- [ ] Kein Code/Kommentar/Bezeichner aus dem Legacy-Baum übernommen (Clean-Room-Prüfung gelaufen:
      `npm run cleanroom`, Ergebnis im PR genannt).
- [ ] Spezifikation aktualisiert, falls Verhalten/Format betroffen ist.
- [ ] Tests ergänzt bzw. angepasst (Unit/Integration; Golden-File bei Berechnungslogik).
- [ ] Lizenz- und Herkunftshinweise unverändert korrekt (`LICENSE`, `docs/provenance.md`).
- [ ] Keine Legacy-Dateien, Archive oder Datenkopien im Commit (`SmallTime-master/`, `*.zip`).

## 4. Code-Konventionen

- **TypeScript** (strict), ESLint mit `@iobroker/eslint-config`, Prettier; keine deutschen Bezeichner
  im Code (Ausnahme: fachliche Begriffe, die bewusst so dokumentiert sind, z. B. `vorholzeit_per_year`).
- **Tests:** Vitest (Unit/Integration), Playwright (E2E, PWA); Testnamen beschreiben Szenario und
  Erwartung („baut Paare nach (ts_utc, id)", nicht „test1").
- **Zeiten:** intern immer UTC-Epoch **und** Minuten-Ganzzahlen; Anzeige über Benutzer-Zeitzone.
- **Datenbank:** Änderungen ausschließlich über versionierte Migrationen (`schema_migrations`).
- **Fehler:** API-Fehler als `application/problem+json` mit stabilen Fehlercodes (Projektprompt 4.10).
- **Commits:** kurze, sachliche Beschreibung im Imperativ; ein Commit pro logischer Änderung.

## 5. Sicherheitsrelevante Änderungen

Betroffen sind insbesondere Authentifizierung, Session-/Token-Handling, RBAC, Audit, Import und
Terminal-Endpunkte. Solche Änderungen benötigen: Beschreibung des Risikos, Test der Negativfälle
(Rechte, CSRF, Idempotenz, `409`) und Aktualisierung der Sicherheitscheckliste im Projektprompt
(Abschnitt 8).
