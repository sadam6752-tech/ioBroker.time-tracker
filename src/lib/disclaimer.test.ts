/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(__dirname, "..", "..");

describe("disclaimer", () => {
	it("is part of the README in English, with the German version in docs", () => {
		const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
		expect(readme).to.contain("## Disclaimer");
		expect(readme).to.contain("**Disclaimer.**");
		// the checker (E6015) wants the README in English only, so the German text lives in docs/
		expect(readme).to.not.contain("Haftungsausschluss.");
		expect(readme).to.contain("docs/haftungsausschluss.md");
		const german = fs.readFileSync(path.join(root, "docs", "haftungsausschluss.md"), "utf8");
		expect(german).to.contain("**Haftungsausschluss.**");
	});

	it("is shown in the web app in every language", () => {
		const dir = path.join(root, "src-www", "src", "i18n");
		const files = fs.readdirSync(dir).filter(name => name.endsWith(".json"));
		expect(files).to.have.length(11);
		for (const file of files) {
			const texts = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, string>;
			expect(texts["app.disclaimer"], file).to.be.a("string").and.to.have.length.greaterThan(40);
		}
	});

	it("is on the sign-in page and in the profile", () => {
		for (const screen of ["Login.tsx", "Profile.tsx"]) {
			const code = fs.readFileSync(path.join(root, "src-www", "src", "screens", screen), "utf8");
			expect(code, screen).to.contain("<Disclaimer />");
		}
	});
});
