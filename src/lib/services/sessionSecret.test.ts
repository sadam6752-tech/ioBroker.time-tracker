/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MIN_SECRET_LENGTH,
	SECRET_FILE_NAME,
	generateSecret,
	readStoredSecret,
	resolveSessionSecret,
	writeStoredSecret,
} from "./sessionSecret";

describe("session secret", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "time-tracker-secret-"));
		file = path.join(dir, SECRET_FILE_NAME);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("takes a configured secret and never touches the file", () => {
		const resolved = resolveSessionSecret({ configured: "  handverlesen  ", file });

		expect(resolved.secret).to.equal("handverlesen");
		expect(resolved.source).to.equal("configured");
		expect(resolved.file).to.equal(null);
		expect(fs.existsSync(file)).to.equal(false);
	});

	it("generates a secret on the first start and reuses it afterwards", () => {
		const first = resolveSessionSecret({ file });

		expect(first.source).to.equal("generated");
		expect(first.file).to.equal(file);
		expect(first.secret).to.have.lengthOf(43);
		expect(fs.readFileSync(file, "utf8").trim()).to.equal(first.secret);

		// the next start (a restart, another process) finds the stored value
		const second = resolveSessionSecret({ configured: "   ", file });
		expect(second.source).to.equal("stored");
		expect(second.secret).to.equal(first.secret);
		expect(second.file).to.equal(file);
	});

	it("replaces a file that is too short to be a secret", () => {
		fs.writeFileSync(file, "kurz\n", "utf8");

		const resolved = resolveSessionSecret({ file });

		expect(resolved.source).to.equal("generated");
		expect(resolved.secret.length).to.be.at.least(MIN_SECRET_LENGTH);
		expect(fs.readFileSync(file, "utf8").trim()).to.equal(resolved.secret);
	});

	it("keeps working when the secret cannot be stored", () => {
		// a file where the directory should be makes the write fail
		fs.writeFileSync(path.join(dir, "blocked"), "x", "utf8");

		const resolved = resolveSessionSecret({ file: path.join(dir, "blocked", SECRET_FILE_NAME) });

		expect(resolved.source).to.equal("generated");
		expect(resolved.file).to.equal(null);
		expect(resolved.error).to.be.a("string").and.not.equal("");
		expect(resolved.secret).to.have.lengthOf(43);
	});

	it("reads only usable secrets and generates a value per call", () => {
		expect(readStoredSecret(file)).to.equal(null);

		writeStoredSecret(file, "ein-sehr-langes-geheimnis");
		expect(readStoredSecret(file)).to.equal("ein-sehr-langes-geheimnis");

		expect(generateSecret()).to.have.lengthOf(43);
		expect(generateSecret()).to.not.equal(generateSecret());
	});
});
