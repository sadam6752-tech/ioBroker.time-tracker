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
RFID, Monatsberichte, Live-Events, Sicherungen mit getestetem Restore, gemessene Pausen, Tag-Notizen für die
Verwaltung). Zeiten ändert die Verwaltung: ein Mitarbeiter stempelt und hinterlässt an einem Tag eine Notiz
(„An-/Ausstempeln vergessen"), die die Verwaltung im Monat sieht, den Tag bucht und als erledigt abhakt; das
Administrator-Konto gehört niemandem und stempelt nicht. Die Suiten laufen grün:
581 Unit-, 60 Paket-, 9 Integrations- und 31 End-to-End-Tests. Die Veröffentlichung läuft über die CI (npm trusted
publishing mit Herkunftsnachweis); offen ist nur noch der
Eintrag im offiziellen Adapter-Repository (Antrag ioBroker/ioBroker.repositories#6702, wartet auf die Prüfung) — siehe [`docs/entwicklung.md`](entwicklung.md).
