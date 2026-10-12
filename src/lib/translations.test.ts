/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_NAMES } from "./adapter/stateNames";
import { REPORT_LABELS } from "./reports/labels";

const LANGUAGES = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
const root = path.join(__dirname, "..", "..");

/**
 * Finds the texts of a language file that are the English text again.
 *
 * The review checklist (V3.5) treats a value that equals the English wording as untranslated, also for words that are
 * valid in the other language ("Port", "Menu"): such a text is written differently.
 *
 * @param folder - folder with one file per language
 * @returns the entries as `language key`
 */
function sameAsEnglish(folder: string): string[] {
	const read = (language: string): Record<string, string> =>
		JSON.parse(fs.readFileSync(path.join(root, folder, `${language}.json`), "utf8")) as Record<string, string>;
	const english = read("en");
	const found: string[] = [];
	for (const language of LANGUAGES.filter(code => code !== "en")) {
		const texts = read(language);
		expect(Object.keys(texts).sort(), `${folder}/${language}.json has the keys of en.json`).to.deep.equal(
			Object.keys(english).sort(),
		);
		for (const [key, value] of Object.entries(texts)) {
			if (value === english[key] && /[A-Za-z]/.test(value)) {
				found.push(`${language} ${key}`);
			}
		}
	}
	return found;
}

describe("translations", () => {
	it("has no text of the admin interface that equals the English wording", () => {
		expect(sameAsEnglish("admin/i18n")).to.deep.equal([]);
	});

	it("has no text of the web app that equals the English wording", () => {
		expect(sameAsEnglish("src-www/src/i18n")).to.deep.equal([]);
	});

	it("has no label of a report that equals the English wording", () => {
		const english = REPORT_LABELS.en as unknown as Record<string, string>;
		const found: string[] = [];
		for (const language of LANGUAGES.filter(code => code !== "en")) {
			const labels = REPORT_LABELS[language] as unknown as Record<string, string>;
			for (const [key, value] of Object.entries(labels)) {
				if (value === english[key] && /[A-Za-z]/.test(value)) {
					found.push(`${language} ${key}`);
				}
			}
		}
		expect(found).to.deep.equal([]);
	});

	it("has no name of an object that equals the English wording", () => {
		const found: string[] = [];
		for (const [id, names] of Object.entries(STATE_NAMES)) {
			const texts = names as unknown as Record<string, string>;
			expect(Object.keys(texts).sort(), id).to.deep.equal([...LANGUAGES].sort());
			for (const language of LANGUAGES.filter(code => code !== "en")) {
				if (texts[language] === texts.en && /[A-Za-z]/.test(texts.en)) {
					found.push(`${language} ${id}`);
				}
			}
		}
		expect(found).to.deep.equal([]);
	});

	it("has no text of io-package.json that equals the English wording", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "io-package.json"), "utf8")) as unknown;
		const found: string[] = [];
		const walk = (value: unknown, where: string): void => {
			if (Array.isArray(value)) {
				value.forEach((item, index) => walk(item, `${where}[${index}]`));
			} else if (value !== null && typeof value === "object") {
				const record = value as Record<string, unknown>;
				if ("en" in record && "de" in record && Object.values(record).every(item => typeof item === "string")) {
					expect(Object.keys(record).sort(), where).to.deep.equal([...LANGUAGES].sort());
					for (const language of LANGUAGES.filter(code => code !== "en")) {
						if (record[language] === record.en && /[A-Za-z]/.test(record.en as string)) {
							found.push(`${language} ${where}`);
						}
					}
				} else {
					Object.entries(record).forEach(([key, item]) => walk(item, `${where}.${key}`));
				}
			}
		};
		walk(pkg, "io-package.json");
		expect(found).to.deep.equal([]);
	});
});
