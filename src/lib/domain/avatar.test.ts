/**
 * Pictures of employees: what is accepted as a picture and what is refused.
 */

/// <reference types="mocha" />
import { expect } from "chai";
import { MAX_AVATAR_BYTES, parseAvatarDataUrl, readAvatar } from "./avatar";

/** A 1×1 PNG as the administration would send it. */
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("avatar pictures", () => {
	it("accepts a data URL of a picture", () => {
		const parsed = parseAvatarDataUrl(PNG);

		expect(parsed?.contentType).to.equal("image/png");
		expect(parsed?.bytes).to.be.greaterThan(0);
		expect(parsed?.base64).to.equal(PNG.slice("data:image/png;base64,".length));
	});

	it("accepts the types a browser can upload", () => {
		expect(parseAvatarDataUrl(PNG.replace("image/png", "image/jpeg"))?.contentType).to.equal("image/jpeg");
		expect(parseAvatarDataUrl(PNG.replace("image/png", "image/webp"))?.contentType).to.equal("image/webp");
		expect(parseAvatarDataUrl(PNG.replace("image/png", "image/gif"))?.contentType).to.equal("image/gif");
	});

	it("refuses everything that is not a picture", () => {
		expect(parseAvatarDataUrl("")).to.equal(null);
		expect(parseAvatarDataUrl("https://example.org/anna.png")).to.equal(null);
		expect(parseAvatarDataUrl("data:image/svg+xml;base64,PHN2Zy8+")).to.equal(null);
		expect(parseAvatarDataUrl("data:text/html;base64,PGI+")).to.equal(null);
		expect(parseAvatarDataUrl("data:image/png,nicht-base64")).to.equal(null);
	});

	it("refuses a picture that is too large", () => {
		const payload = "A".repeat(Math.ceil(((MAX_AVATAR_BYTES + 3) * 4) / 3));

		expect(parseAvatarDataUrl(`data:image/png;base64,${payload}`)).to.equal(null);
	});

	it("reads only what is usable from the database", () => {
		expect(readAvatar(PNG)?.contentType).to.equal("image/png");
		expect(readAvatar(null)).to.equal(null);
		expect(readAvatar("")).to.equal(null);
		expect(readAvatar("kaputt")).to.equal(null);
	});
});
