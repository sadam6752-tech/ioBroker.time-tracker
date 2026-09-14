/// <reference types="mocha" />
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HttpRequest, HttpResponse } from "./router";
import { createStaticHandler } from "./static";

describe("static files", () => {
	let root: string;
	let outer: string;
	let handler: ReturnType<typeof createStaticHandler>;

	beforeEach(() => {
		outer = fs.mkdtempSync(path.join(os.tmpdir(), "zeiterfassung-static-"));
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
});
