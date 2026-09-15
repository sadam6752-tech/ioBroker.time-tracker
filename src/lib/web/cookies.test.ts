/// <reference types="mocha" />
import { expect } from "chai";
import { SESSION_COOKIE, clearCookie, parseCookies, serializeCookie } from "./cookies";

describe("cookie helpers", () => {
	it("reads the cookies of a header", () => {
		const cookies = parseCookies("zt_session=abc.def; other=1; leer=");
		expect(cookies).to.deep.equal({ zt_session: "abc.def", other: "1", leer: "" });
	});

	it("ignores broken entries instead of throwing", () => {
		// a damaged cookie header must not break the request, it simply does not authenticate
		expect(parseCookies("kaputt; =wert; zt_session=%E0%A4%A")).to.deep.equal({ zt_session: "%E0%A4%A" });
		expect(parseCookies(undefined)).to.deep.equal({});
		expect(parseCookies("")).to.deep.equal({});
	});

	it("decodes values and keeps spaces around the separators harmless", () => {
		const cookies = parseCookies("zt_session = a%20b%3Bc ;  x=1");
		expect(cookies.zt_session).to.equal("a b;c");
		expect(cookies.x).to.equal("1");
	});

	it("writes an httpOnly session cookie with SameSite=Lax by default", () => {
		const header = serializeCookie(SESSION_COOKIE, "abc123", { maxAgeSeconds: 720 * 60 });
		expect(header).to.equal("zt_session=abc123; Path=/; Max-Age=43200; SameSite=Lax; HttpOnly");
	});

	it("adds Secure and SameSite=None only when they are asked for", () => {
		const secure = serializeCookie(SESSION_COOKIE, "abc", { maxAgeSeconds: 60, secure: true });
		expect(secure).to.contain("; Secure");
		const crossSite = serializeCookie(SESSION_COOKIE, "abc", { sameSite: "None", secure: true });
		expect(crossSite).to.contain("SameSite=None");
		const readable = serializeCookie("zt_csrf", "abc", { httpOnly: false });
		expect(readable).to.not.contain("HttpOnly");
	});

	it("never writes a negative lifetime and encodes the value", () => {
		expect(serializeCookie("zt_session", "a;b=c", { maxAgeSeconds: -5, path: "" })).to.equal(
			"zt_session=a%3Bb%3Dc; Max-Age=0; SameSite=Lax; HttpOnly",
		);
	});

	it("removes a cookie with Max-Age=0 and the same flags", () => {
		const header = clearCookie(SESSION_COOKIE, { secure: true });
		expect(header).to.equal("zt_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure");
	});
});
