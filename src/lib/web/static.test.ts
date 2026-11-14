/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HttpRequest, HttpResponse } from "./router";
import { CONTENT_SECURITY_POLICY, createStaticHandler, kioskFileOf, kioskRedirectOf } from "./static";

describe("static files", () => {
	let root: string;
	let outer: string;
	let handler: ReturnType<typeof createStaticHandler>;

	beforeEach(() => {
		outer = fs.mkdtempSync(path.join(os.tmpdir(), "time-tracker-static-"));
		root = path.join(outer, "www");
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "index.html"), "<h1>Zeiterfassung</h1>");
		fs.writeFileSync(path.join(root, "main.css"), "body{margin:0}");
		fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50]));
		fs.mkdirSync(path.join(root, "assets"));
		fs.writeFileSync(path.join(root, "assets", "chunk.js"), "export const x = 1;");
		fs.writeFileSync(path.join(outer, "secret.txt"), "geheim");
		handler = createStaticHandler({ root });
	});

	afterEach(() => {
		fs.rmSync(outer, { recursive: true, force: true });
	});

	const request = (pathOfRequest: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
		method: "GET",
		path: pathOfRequest,
		query: {},
		headers: {},
		body: "",
		remoteAddress: "127.0.0.1",
		...extra,
	});

	it("delivers a file with type, validators and cache header", () => {
		const response = handler(request("/main.css")) as HttpResponse;
		expect(response.status).to.equal(200);
		expect(response.headers["content-type"]).to.equal("text/css; charset=utf-8");
		expect(response.headers["cache-control"]).to.equal("public, max-age=3600");
		expect(response.headers.etag).to.match(/^".+"$/);
		expect(response.headers["last-modified"]).to.be.a("string");
		expect(response.body.toString()).to.equal("body{margin:0}");

		// assets in subdirectories are served as well, unknown types fall back to octet-stream
		const chunk = handler(request("/assets/chunk.js")) as HttpResponse;
		expect(chunk.headers["content-type"]).to.equal("text/javascript; charset=utf-8");
		const unknown = handler(request("/logo.png")) as HttpResponse;
		expect(unknown.headers["content-type"]).to.equal("image/png");
	});

	it("carries the security headers, and the policy only on the page", () => {
		const page = handler(request("/")) as HttpResponse;
		const policy = page.headers["content-security-policy"];
		expect(policy).to.equal(CONTENT_SECURITY_POLICY);
		// nobody may frame the app, no inline script runs, the live stream is allowed to connect
		expect(policy).to.contain("frame-ancestors 'none'");
		expect(policy).to.contain("script-src 'self';");
		expect(policy).to.contain("connect-src 'self' ws: wss:");
		expect(page.headers["x-frame-options"]).to.equal("DENY");
		expect(page.headers["referrer-policy"]).to.equal("no-referrer");
		expect(page.headers["x-content-type-options"]).to.equal("nosniff");
		expect(page.headers["permissions-policy"]).to.contain("camera=()");

		const style = handler(request("/main.css")) as HttpResponse;
		expect(style.headers["content-security-policy"]).to.equal(undefined);
		expect(style.headers["x-frame-options"]).to.equal("DENY");
	});

	it("serves the index for the root and for client side routes", () => {
		const index = handler(request("/")) as HttpResponse;
		expect(index.status).to.equal(200);
		expect(index.headers["content-type"]).to.equal("text/html; charset=utf-8");
		// the page itself must not be cached, otherwise a new release is not picked up
		expect(index.headers["cache-control"]).to.equal("no-cache");
		expect(index.body.toString()).to.contain("Zeiterfassung");

		const clientRoute = handler(request("/profile/7", { headers: { accept: "text/html" } })) as HttpResponse;
		expect(clientRoute.status).to.equal(200);
		expect(clientRoute.body.toString()).to.contain("Zeiterfassung");
	});

	it("does not answer a missing file with the page for an API client", () => {
		const api = handler(request("/missing.json", { headers: { accept: "application/json" } }));
		expect(api).to.equal(null);

		// `*/*` is what a fetch or curl sends, so the page may be delivered
		const wildcard = handler(request("/missing.json", { headers: { accept: "*/*" } })) as HttpResponse;
		expect(wildcard.status).to.equal(200);
	});

	it("answers a conditional request with 304 and keeps 200 for a changed file", () => {
		const first = handler(request("/main.css")) as HttpResponse;
		const etag = first.headers.etag;
		const modified = first.headers["last-modified"];

		const cached = handler(
			request("/main.css", { headers: { "if-none-match": `"andere", ${etag}` } }),
		) as HttpResponse;
		expect(cached.status).to.equal(304);
		expect(cached.body.toString()).to.equal("");

		const byDate = handler(request("/main.css", { headers: { "if-modified-since": modified } })) as HttpResponse;
		expect(byDate.status).to.equal(304);

		fs.writeFileSync(path.join(root, "main.css"), "body{margin:1px}");
		const changed = handler(request("/main.css", { headers: { "if-none-match": etag } })) as HttpResponse;
		expect(changed.status).to.equal(200);
		expect(changed.body.toString()).to.equal("body{margin:1px}");
	});

	it("handles HEAD without a body and ignores other methods", () => {
		const head = handler(request("/main.css", { method: "HEAD" })) as HttpResponse;
		expect(head.status).to.equal(200);
		expect(head.body).to.equal("");
		// the size is still announced, because the client may rely on it
		expect(head.headers["content-length"]).to.equal("14");

		expect(handler(request("/main.css", { method: "POST" }))).to.equal(null);
	});

	it("refuses paths that leave the root directory", () => {
		for (const attempt of [
			"/../secret.txt",
			"/%2e%2e%2fsecret.txt",
			"/assets/../../secret.txt",
			"/..%2fsecret.txt",
		]) {
			const response = handler(request(attempt, { headers: { accept: "*/*" } })) as HttpResponse;
			expect(response.status, attempt).to.equal(404);
			expect(response.body.toString(), attempt).to.not.contain("geheim");
		}
	});

	it("returns null when the root or the page is missing", () => {
		const empty = createStaticHandler({ root: path.join(outer, "does-not-exist") });
		expect(empty(request("/", { headers: { accept: "text/html" } }))).to.equal(null);

		// without an index file a client side route cannot be answered
		fs.rmSync(path.join(root, "index.html"));
		expect(handler(request("/profile", { headers: { accept: "text/html" } }))).to.equal(null);
	});

	describe("kiosk address with the token in the path", () => {
		const token = "kUQh_dAT58nk7ZDiJiCXHgexkY5z6_iUznW9d6fcvwY";

		it("serves the app and its files below the path of the token", () => {
			const page = handler(request(`/terminal/${token}/`, { headers: { accept: "text/html" } }));
			expect(page?.status).to.equal(200);
			expect(String(page?.body)).to.contain("Zeiterfassung");
			const chunk = handler(request(`/presence/${token}/assets/chunk.js`));
			expect(chunk?.status).to.equal(200);
			expect(String(chunk?.body)).to.equal("export const x = 1;");
		});

		it("sends links of the older form and paths without the closing slash to the path of the token", () => {
			const older = handler(request("/terminal", { query: { token } }));
			expect(older?.status).to.equal(302);
			expect(older?.headers.location).to.equal(`/terminal/${token}/`);
			expect(older?.headers["cache-control"]).to.equal("no-store");
			expect(handler(request(`/presence/${token}`))?.headers.location).to.equal(`/presence/${token}/`);
		});

		it("leaves other addresses alone", () => {
			expect(kioskRedirectOf("/terminal")).to.equal(null);
			expect(kioskRedirectOf("/terminal", { token: "no spaces allowed" })).to.equal(null);
			expect(kioskRedirectOf("/", { token })).to.equal(null);
			expect(kioskRedirectOf(`/terminal/${token}/`)).to.equal(null);
			expect(kioskFileOf("/terminal")).to.equal("/terminal");
			expect(kioskFileOf("/assets/chunk.js")).to.equal("/assets/chunk.js");
			expect(kioskFileOf(`/terminal/${token}/sw.js`)).to.equal("/sw.js");
		});

		it("keeps the traversal check below the path of the token", () => {
			const answer = handler(request(`/terminal/${token}/..%2Fsecret.txt`));
			expect(answer?.status).to.equal(404);
		});
	});
});
