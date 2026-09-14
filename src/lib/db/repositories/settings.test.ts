/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "../database";
import { seed } from "../seed";
import { createSettingsRepository } from "./settings";

describe("settings repository", () => {
	let db: Db;
	let repo: ReturnType<typeof createSettingsRepository>;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		repo = createSettingsRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	it("reads the seeded defaults", () => {
		expect(repo.get("edit_window_days")).to.equal("7");
		expect(repo.getNumber("edit_window_days", 0)).to.equal(7);
		expect(repo.getBoolean("absence_calc_until_today", false)).to.equal(true);
		expect(repo.getBoolean("absence_deduct_worktime", true)).to.equal(false);
		expect(repo.get("holiday_country")).to.equal("CH");
		expect(Object.keys(repo.all())).to.include("backup_retention_days");
	});

	it("falls back for missing or invalid values", () => {
		expect(repo.get("does_not_exist")).to.equal(null);
		expect(repo.getNumber("does_not_exist", 42)).to.equal(42);
		expect(repo.getBoolean("does_not_exist", true)).to.equal(true);
		expect(repo.getJson("does_not_exist", { a: 1 })).to.deep.equal({ a: 1 });

		repo.set("not_a_number", "abc");
		expect(repo.getNumber("not_a_number", 9)).to.equal(9);

		repo.set("broken_json", "{not json");
		expect(repo.getJson("broken_json", ["fallback"])).to.deep.equal(["fallback"]);
	});

	it("stores numbers, booleans and objects", () => {
		repo.set("edit_window_days", 30);
		repo.set("kiosk_enabled", true);
		repo.set("pause_staffel", [{ fromMin: 360, pauseMin: 30 }]);

		expect(repo.getNumber("edit_window_days", 0)).to.equal(30);
		expect(repo.getBoolean("kiosk_enabled", false)).to.equal(true);
		expect(repo.getJson("pause_staffel", [])).to.deep.equal([{ fromMin: 360, pauseMin: 30 }]);
	});

	it("audits every change", () => {
		repo.set("edit_window_days", 30, null, 1000);

		const row = db
			.prepare("SELECT action, entity, entity_id AS entityId, detail, at_utc AS atUtc FROM audit_log")
			.get() as { action: string; entity: string; entityId: string; detail: string; atUtc: number };

		expect(row.action).to.equal("settings.set");
		expect(row.entity).to.equal("app_settings");
		expect(row.entityId).to.equal("edit_window_days");
		expect(row.atUtc).to.equal(1000);
		expect(JSON.parse(row.detail)).to.deep.equal({ old: "7", new: "30" });
	});

	it("overwrites existing values", () => {
		repo.set("edit_window_days", 14);
		repo.set("edit_window_days", 21);
		expect(repo.get("edit_window_days")).to.equal("21");
	});

	it("accepts keys that were not seeded", () => {
		repo.set("custom_key", "value");
		expect(repo.get("custom_key")).to.equal("value");
	});
});
