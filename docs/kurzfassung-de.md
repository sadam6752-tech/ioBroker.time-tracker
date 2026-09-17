# Kurzfassung (Deutsch)

Zeiterfassung für ioBroker: Stempeln über die installierbare Web-App (PWA) oder ein Kiosk-Terminal mit
Badge/PIN, Rollen und Rechte, Soll-/Pausen-/Überstunden- und Ferienregeln, Monatsberichte (PDF/XLS),
Abwesenheiten sowie Veröffentlichung von Aggregaten als ioBroker-States – alle Daten lokal in SQLite.
Je Terminal sind PIN-Pflicht und Mitarbeiter einstellbar, und Logo, Hintergrundbild sowie Akzentfarbe sind
als Firmen-Branding hinterlegbar. Eigenständige Neuimplementierung unter MIT-Lizenz.

**Hinweis:** Die `README.md` selbst ist bewusst **nur englisch** (Vorgabe des ioBroker-Adapterscheckers,
Regel `E6015`). Diese Kurzfassung liegt deshalb hier im `docs/`-Ordner; die übersetzte Adapter-Beschreibung
für die ioBroker-Oberfläche steht in `io-package.json` (`common.desc`, `common.titleLang`) in allen 11 Sprachen.

**Status:** Der Adapter ist implementiert und getestet (Datenbank, Domänenlogik, REST-API mit Rollen,
Web-App mit Offline-Warteschlange, Badge-/PIN-Terminal mit Mitarbeiterzuordnung je Gerät, Anwesenheits-Bildschirm,
RFID, Monatsberichte, Live-Events, Sicherungen mit getestetem Restore). Die Suiten laufen grün: 450 Unit-,
60 Paket-, 10 Integrations- und 17 End-to-End-Tests. Die Veröffentlichung läuft (`0.0.7` auf npm, über npm trusted
publishing mit Herkunftsnachweis); offen sind der Abnahmelauf auf echter Hardware (Layouts, PDF-Schriften) und der
Eintrag im offiziellen Adapter-Repository — siehe Abschnitt „Still open" in der `README.md`.
