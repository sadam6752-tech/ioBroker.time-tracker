/// <reference types="mocha" />
/**
 * Unit tests for the adapter scaffolding.
 *
 * Further test files follow the same pattern: `src/**\/*.test.ts` (run with `npm run test:ts`).
 * Domain logic tests (punch pairing, target time, overtime, migration parser) are added in Phases 2–3.
 */

import { expect } from "chai";
import ioPackage from "../io-package.json";
import pkg from "../package.json";

describe("adapter scaffolding", () => {
	it("uses the ioBroker naming convention", () => {
		// GitHub repository: ioBroker.time-tracker, npm package: iobroker.time-tracker (lower case)
		expect(pkg.name).to.equal("iobroker.time-tracker");
		expect(ioPackage.common.name).to.equal("time-tracker");
	});

	it("declares the required ioBroker package metadata", () => {
		expect(pkg.dependencies["@iobroker/adapter-core"]).to.be.a("string");
		expect(ioPackage.common.licenseInformation.license).to.equal("MIT");
		expect(ioPackage.common.mode).to.equal("daemon");
		expect(ioPackage.common.type).to.be.a("string").and.not.be.empty;
		expect(ioPackage.common.connectionType).to.be.oneOf(["local", "cloud"]);
		expect(ioPackage.common.dataSource).to.be.oneOf(["poll", "push", "assumption"]);
		expect(ioPackage.common.adminUI.config).to.equal("json");
	});

	it("provides the connection indicator state", () => {
		const connectionState = ioPackage.instanceObjects.find(obj => obj._id === "info.connection");
		expect(connectionState, "info.connection must exist in instanceObjects").to.not.be.undefined;
		expect(connectionState?.common.role).to.equal("indicator.connected");
		expect(connectionState?.common.type).to.equal("boolean");
		expect(connectionState?.common.read).to.equal(true);
		expect(connectionState?.common.write).to.equal(false);
	});

	it("defines the version in both package files", () => {
		expect(ioPackage.common.version).to.equal(pkg.version);
	});
});
