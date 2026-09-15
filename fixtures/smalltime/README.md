# Synthetic SMALL-Time fixture

**Synthetic data — not a real installation.** It follows the formats documented in `PROJECT_PROMPT.md`
(2.9 and appendix 11) so the legacy import can be developed and tested without a productive `Data`
directory. Regenerate with `node tools/make-legacy-fixture.mjs`.

| Item | Value |
| --- | --- |
| Admin | `administrator` (group 1), legacy password hash of `admin` |
| Employee | `TeilZeit1` — 60 %, 25.5 h/week, workdays Monday to Friday, ends 12/2026 |
| Punches | 4 days in 2/2026, 08:00–12:30 and 13:30–14:30 local |
| Worked | 22.00 h in that month |
| Daily target | 5.10 h (25.5 h / 5 days) |
| Monthly target | 102.00 h (20 working days) |
| Absences | `A2026` with two rows, `absenz.txt` with seven types |
| Payout | one row in `auszahlungen` (3 h) |

The target hours in `Timetable/2026` come from the calendar (working days × daily target), the balance from
the punch durations — computed independently of the adapter, so they can serve as a golden reference.
