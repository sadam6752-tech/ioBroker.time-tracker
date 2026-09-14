# Herkunft der Spezifikation und der Umsetzung

Dieses Dokument ist der Nachweis für die Clean-Room-Regel aus `PROJECT_PROMPT.md`, Abschnitt 12.5.
Es ist bei jeder relevanten Änderung (neuer Bezug von Referenzdaten, Prüfläufe, Portierungen) fortzuschreiben.

## 1. Referenzsystem (nur Referenz, **nicht** Teil dieses Repositories)

- System: SMALL-Time (SmallTime) **v0.9.205**
- Urheber/Anbieter: IT-Master, `www.it-master.ch` / `info@it-master.ch`
- Lizenz des Referenzsystems: **GNU Affero General Public License v3 (AGPL-3.0)**
- Bezugsquelle: <URL oder Archivname eintragen>, bezogen am <TT.MM.JJJJ>
- Ablage: außerhalb dieses Repositories (`../SmallTime-master/`, in `.gitignore` ausgeschlossen)

## 2. Ermittelte Grundlagen (unabhängig, ohne Codeübernahme)

- Datei- und Datenformate der Altdaten: `Data/users.txt`, `Data/group.txt`, `<user>/userdaten.txt`,
  `<user>/absenz.txt`, `<user>/Timetable/<Jahr>.<Monat>`, `Timetable/A<Jahr>`, `Timetable/<Jahr>`,
  `Timetable/auszahlungen`, `total.txt`
- Feldbedeutungen und Feldindizes, Einheiten (Dezimalstunden) und Normalisierungsregeln
- Berechnungsregeln: Soll pro Tag, Pausen (pro Zeitenpaar, Staffel), Saldo, Überstundenmodelle,
  Vorholzeit, Ferien, Abwesenheitsanrechnung, `end_date`
- Bedienabläufe und **Ausgaben** der Referenzinstallation (Vergleichswerte für Golden-Tests)
- Dokumentiert in `PROJECT_PROMPT.md`, Abschnitte 2.9, 3 und 11

## 3. Feststellung

Es wurde **kein Quellcode** des Referenzsystems übernommen — keine Programmdateien, Kommentare,
Meldungstexte, Klassennamen oder Bezeichner. Ebenso wurden keine Legacy-Dateien automatisch
portiert oder übersetzt. Die Umsetzung erfolgt eigenständig anhand der Spezifikation
(`PROJECT_PROMPT.md`). Die Lizenz dieses Projekts ist **MIT** (siehe `LICENSE`).

Zulässig und verwendet: technische Fakten (Dateinamen/-formate, Feldindizes), Berechnungsregeln und
Verhalten, die für die Weiterverwendung der Bestandsdaten erforderlich sind.

## 4. Prüfungen

| Datum | Prüfung | Werkzeug | Ergebnis |
|---|---|---|---|
| 14.09.2026 | Anlage Gerüst (Lizenz, Metadaten, Clean-Room-Regeln) | manuell | erledigt (Phase 0) |
| <TT.MM.JJJJ> | Clean-Room-Abgleich eigene Quellen ↔ Legacy-Baum | `tools/cleanroom-check.ps1` | <offen> |

Prüfaufruf (Windows und Linux-CI identisch, benötigt `pwsh`):

```bash
pwsh -NoProfile -File tools/cleanroom-check.ps1 -LegacyPath ../SmallTime-master -SourcePaths adapter,pwa,shared -FailOnHit
```

Ein Treffer ist ein **Prüffall**, kein Beweis: kurze technische Bezeichner und Formatangaben sind
zulässig, kopierter Code und kopierte Kommentare nicht.

## 5. Ansprechpartner

- <Name, Kontakt>
- Datum der letzten Änderung: 14.09.2026
