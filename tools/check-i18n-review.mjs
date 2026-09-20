/**
 * Technical review helper for the eleven PWA language files.
 *
 * `npm run check:i18n` proves the formal side (same keys as the base file, nothing left in English, placeholders
 * complete). This script looks at what that check cannot see and reports candidates to look at by hand:
 *
 * 1. values of a language that do not contain the letters of that language at all (Russian and Ukrainian need
 *    Cyrillic, Chinese needs CJK) — that is how a text that was never translated survives every formal check,
 * 2. the same text in two non-English languages — often a copy of a sibling language (es/pt, ru/uk),
 * 3. values much longer than the English original — a layout risk in buttons and table columns,
 * 4. values much shorter than the English original — a part of the sentence that never made it into the
 *    translation (found this way: six languages had lost “empty for the default” in a hint).
 *
 * It does not judge wording: idiom, tone, case and gender agreement stay with a native speaker.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Language files of the web app; derived from this file so the repository can be moved or renamed */
const dir = fileURLToPath(new URL("../src-pwa/src/i18n", import.meta.url));
const base = JSON.parse(readFileSync(`${dir}/en.json`, "utf8"));
const languages = readdirSync(dir)
	.filter(file => file.endsWith(".json") && file !== "en.json")
	.map(file => file.replace(/\.json$/, ""))
	.sort();

/** Letters every longer value of a language has to contain */
const requiredScript = {
	ru: { letters: /[\u0400-\u04FF]/, name: "Cyrillic" },
	uk: { letters: /[\u0400-\u04FF]/, name: "Cyrillic" },
	"zh-cn": { letters: /[\u4E00-\u9FFF]/, name: "CJK" },
};

const loaded = Object.fromEntries(
	languages.map(lang => [lang, JSON.parse(readFileSync(`${dir}/${lang}.json`, "utf8"))]),
);

let findings = 0;
const note = line => {
	findings += 1;
	console.log(line);
};

// 1) values without the letters of their own language
for (const [lang, rule] of Object.entries(requiredScript)) {
	const data = loaded[lang];
	if (!data) {
		continue;
	}
	for (const [key, value] of Object.entries(data)) {
		// a value that is only placeholders and punctuation carries no letters of its own (e.g. “{{date}} · {{time}}”),
		// and one that matches the English original is deliberately kept (e.g. “Excel”)
		if (typeof value !== "string" || value === base[key]) {
			continue;
		}
		const letters = value.replace(/\{\{[^}]+\}\}/g, "").replace(/[^\p{L}]/gu, "");
		if (letters.length < 3) {
			continue;
		}
		if (!rule.letters.test(letters)) {
			note(`${lang}: ${key} has no ${rule.name} letters — “${value}”`);
		}
	}
}

// 2) the same text in two languages
const short = value => value.trim().length < 12;
const pairs = new Map();
for (const lang of languages) {
	for (const [key, value] of Object.entries(loaded[lang])) {
		if (typeof value !== "string" || short(value)) {
			continue;
		}
		const bucket = pairs.get(`${key}\u0000${value}`) ?? [];
		bucket.push(lang);
		pairs.set(`${key}\u0000${value}`, bucket);
	}
}
for (const [bucket, langs] of pairs) {
	if (langs.length > 1) {
		const [, value] = bucket.split("\u0000");
		note(`${langs.join("+")}: same text — “${value}”`);
	}
}

// 3) much longer than the English original
for (const lang of languages) {
	for (const [key, value] of Object.entries(loaded[lang])) {
		const original = base[key];
		if (typeof value !== "string" || typeof original !== "string" || original.length < 12) {
			continue;
		}
		if (value.length > original.length * 2.5) {
			note(`${lang}: ${key} is ${value.length} characters against ${original.length} in English`);
		}
	}
}

// 4) much shorter than the English original — a part of the sentence that never made it into the translation
// (Chinese is left out: characters are not comparable with Latin letters, so the ratio says nothing there)
for (const lang of languages) {
	if (lang === "zh-cn") {
		continue;
	}
	for (const [key, value] of Object.entries(loaded[lang])) {
		const original = base[key];
		if (typeof value !== "string" || typeof original !== "string" || original.length < 24) {
			continue;
		}
		if (value.length < original.length * 0.6) {
			note(`${lang}: ${key} is only ${value.length} characters against ${original.length} in English`);
		}
	}
}

console.log(
	findings === 0
		? "Nichts Auffälliges: alle Werte tragen die Schrift ihrer Sprache, keine Kopien, keine Ausreisser."
		: `${findings} Hinweis(e) zum Ansehen — Wörter und Ton bleiben Sache eines Muttersprachlers.`,
);
