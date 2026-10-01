// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			/** HTTP port of the built-in server (PWA, API, terminal) */
			port: number;
			/** Bind address, e.g. 0.0.0.0 for all interfaces */
			bind: string;
			/** Database file; empty = <adapter data dir>/time-tracker.sqlite */
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
			/** Login of the first administrator (created when the instance has none) */
			adminLogin: string;
			/** Start password of the first administrator (encrypted at rest, empty = generated) */
			adminPassword: string;
			/** Enable the kiosk terminal */
			kioskEnabled: boolean;
			/**
			 * Trust `x-forwarded-*` of a reverse proxy: the forwarded client address is used for the rate
			 * limits and the audit trail, `x-forwarded-proto: https` makes the session cookie `Secure`.
			 */
			trustProxy: boolean;
			/** Serve the app over HTTPS with a certificate of the ioBroker certificate collection */
			secure: boolean;
			/** Name of the public certificate in the collection (HTTPS only) */
			certPublic: string;
			/** Name of the private key in the collection (HTTPS only) */
			certPrivate: string;
			/** Name of the certificate chain in the collection, optional (HTTPS only) */
			certChained: string;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
