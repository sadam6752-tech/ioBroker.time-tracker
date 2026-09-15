# Kurzfassung (Deutsch)

Zeiterfassung für ioBroker: Stempeln über die installierbare Web-App (PWA) oder ein Kiosk-Terminal mit
Badge/PIN, Rollen und Rechte, Soll-/Pausen-/Überstunden- und Ferienregeln, Monatsberichte (PDF/XLS),
Abwesenheiten sowie Veröffentlichung von Aggregaten als ioBroker-States – alle Daten lokal in SQLite.
Eigenständige Neuimplementierung unter MIT-Lizenz; der Import bestehender SMALL-Time-Daten ist vorgesehen.

**Hinweis:** Die `README.md` selbst ist bewusst **nur englisch** (Vorgabe des ioBroker-Adapterscheckers,
Regel `E6015`). Diese Kurzfassung liegt deshalb hier im `docs/`-Ordner; die übersetzte Adapter-Beschreibung
für die ioBroker-Oberfläche steht in `io-package.json` (`common.desc`, `common.titleLang`) in allen 11 Sprachen.

**Status:** Der Adapter ist implementiert und getestet (Datenbank, Domänenlogik, REST-API mit Rollen,
Web-App mit Offline-Warteschlange, Badge-/PIN-Terminal, RFID, Monatsberichte, Live-Events, Sicherungen mit
getestetem Restore). Offen sind vor allem die Migration der Altdaten, die Abnahmetests und die
Veröffentlichung — siehe Abschnitt „Still open" in der `README.md`.
