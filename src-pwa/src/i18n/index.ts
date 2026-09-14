/**
 * Translations of the web app.
 *
 * `i18next` with a flat key set; English is the base and the fallback. The language comes from the logged in
 * user (the adapter stores it per user), otherwise from the browser. API errors are translated by their stable
 * code (see `api.client`), never by their message.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import de from "./de.json";
import ru from "./ru.json";
import pt from "./pt.json";
import nl from "./nl.json";
import fr from "./fr.json";
import it from "./it.json";
import es from "./es.json";
import pl from "./pl.json";
import uk from "./uk.json";
import zhCn from "./zh-cn.json";

/** Languages the adapter ships. */
export const SUPPORTED_LANGUAGES = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"] as const;

/** A supported language code. */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const resources = {
	en: { translation: en },
	de: { translation: de },
	ru: { translation: ru },
	pt: { translation: pt },
	nl: { translation: nl },
	fr: { translation: fr },
	it: { translation: it },
	es: { translation: es },
	pl: { translation: pl },
	uk: { translation: uk },
	"zh-cn": { translation: zhCn },
} as const;

/**
 * Picks the language to start with.
 *
 * @returns language code the app uses until a user is known
 */
export function detectLanguage(): Language {
	if (typeof navigator === "undefined") {
		return "en";
	}
	const candidates = [...(navigator.languages ?? []), navigator.language];
	for (const candidate of candidates) {
		const lower = candidate.toLowerCase();
		const exact = SUPPORTED_LANGUAGES.find(language => language === lower);
		if (exact) {
			return exact;
		}
		const base = lower.split("-")[0];
		const match = SUPPORTED_LANGUAGES.find(language => language === base);
		if (match) {
			return match;
		}
		// Chinese is shipped as `zh-cn`
		if (base === "zh") {
			return "zh-cn";
		}
	}
	return "en";
}

/**
 * Resolves a language code of the adapter (user setting) to one the app ships.
 *
 * @param value - language code from the user record
 * @returns supported language
 */
export function normaliseLanguage(value: string | undefined): Language {
	const lower = (value ?? "").toLowerCase();
	const exact = SUPPORTED_LANGUAGES.find(language => language === lower);
	if (exact) {
		return exact;
	}
	const base = lower.split("-")[0];
	return SUPPORTED_LANGUAGES.find(language => language === base) ?? detectLanguage();
}

void i18n.use(initReactI18next).init({
	resources,
	lng: detectLanguage(),
	fallbackLng: "en",
	interpolation: { escapeValue: false },
	returnNull: false,
});

export default i18n;
