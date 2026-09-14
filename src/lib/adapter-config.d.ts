// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			/** HTTP port of the built-in server (PWA, API, terminal) */
			port: number;
			/** Bind address, e.g. 0.0.0.0 for all interfaces */
			bind: string;
			/** Database file; empty = <adapter data dir>/zeiterfassung.sqlite */
			dbPath: string;
			/** Time zone used as instance fallback (IANA name) */
			timezone: string;
			/** Language for new users (one of the 11 supported languages) */
			defaultLanguage: string;
			/** Country used to generate public holidays */
			holidayCountry: string;
			/** Secret for session cookies/tokens (encrypted at rest) */
			sessionSecret: string;
			/** Secret for signed badge/NFC links (encrypted at rest) */
			hmacSecret: string;
			/** Session lifetime in minutes */
			sessionTtlMinutes: number;
			/** Days a user may edit his own punches */
			editWindowDays: number;
			/** Round quick punches to this amount of minutes (0 = off) */
			quickRoundMinutes: number;
			/** Calculate absences only until today */
			absenceCalcUntilToday: boolean;
			/** Subtract working time from absences */
			absenceDeductWorktime: boolean;
			/** Retention of database backups in days */
			backupRetentionDays: number;
			/** Legacy (SMALL-Time) data directory used for the import */
			legacyDataDir: string;
			/** Enable the kiosk terminal */
			kioskEnabled: boolean;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};