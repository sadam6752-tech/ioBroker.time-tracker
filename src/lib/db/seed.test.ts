/// <reference types="mocha" />
import { expect } from "chai";
import { openAndMigrate, type Db } from "./database";
import { ABSENCE_TYPES, ALL_PERMISSIONS, ROLE_PERMISSIONS, SETTING_DEFAULTS, seed } from "./seed";

function permissionsOf(db: Db, roleKey: string): string[] {
	const rows = db
		.prepare(
			`SELECT p.key AS key
			 FROM permissions p
			 JOIN role_permissions rp ON rp.permission_id = p.id
			 JOIN roles r ON r.id = rp.role_id
			 WHERE r.key = ?
			 ORDER BY p.key`,
		)
		.all(roleKey) as { key: string }[];
	return rows.map(row => row.key);
}

describe("seeds", () => {
	let db: Db;

	beforeEach(() => {
		db = openAndMigrate(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("creates the three roles", () => {
		seed(db, { holidayYears: [2026] });
		const roles = db.prepare("SELECT key FROM roles ORDER BY key").all() as { key: string }[];
		expect(roles.map(role => role.key)).to.deep.equal(["admin", "employee", "manager"]);
	});

	it("registers the complete permission catalogue", () => {
		const result = seed(db, { holidayYears: [2026] });
		expect(result.permissions).to.equal(ALL_PERMISSIONS.length);
		expect(ALL_PERMISSIONS.length).to.be.greaterThan(25);
	});

	it("grants the admin role every permission", () => {
		seed(db, { holidayYears: [2026] });
		expect(permissionsOf(db, "admin").sort()).to.deep.equal([...ALL_PERMISSIONS].sort());
	});

	it("gives the employee role only the basic permissions", () => {
		seed(db, { holidayYears: [2026] });
		expect(permissionsOf(db, "employee").sort()).to.deep.equal([...ROLE_PERMISSIONS.employee].sort());
	});

	it("keeps administration rights out of the manager role", () => {
		seed(db, { holidayYears: [2026] });
		const manager = permissionsOf(db, "manager");
		expect(manager).to.include("time.edit_other");
		expect(manager).to.not.include("settings.edit");
		expect(manager).to.not.include("user.manage_roles");
		expect(manager).to.not.include("import.run");
		expect(manager).to.not.include("backup.run");
	});

	it("creates the default absence types", () => {
		seed(db, { holidayYears: [2026] });
		const rows = db
			.prepare("SELECT code, factor, reduce_vacation FROM absence_types WHERE user_id IS NULL ORDER BY code")
			.all() as { code: string; factor: number; reduce_vacation: number }[];

		expect(rows).to.have.lengthOf(ABSENCE_TYPES.length);
		expect(rows.map(row => row.code)).to.deep.equal(["E", "F", "I", "K", "M", "U", "W"]);
		expect(rows.find(row => row.code === "F")?.reduce_vacation).to.equal(1);
		expect(rows.find(row => row.code === "K")?.reduce_vacation).to.equal(0);
		expect(rows.find(row => row.code === "W")?.factor).to.equal(50);
	});

	it("writes the instance defaults", () => {
		seed(db, { holidayCountry: "DE", holidayYears: [2026] });
		const settings = Object.fromEntries(
			(db.prepare("SELECT key, value FROM app_settings").all() as { key: string; value: string }[]).map(row => [
				row.key,
				row.value,
			]),
		);

		expect(Object.keys(settings).sort()).to.deep.equal(Object.keys(SETTING_DEFAULTS).sort());
		expect(settings.holiday_country).to.equal("DE");
		expect(settings.edit_window_days).to.equal("7");
	});

	it("never overwrites modified settings", () => {
		seed(db, { holidayYears: [2026] });
		db.prepare("UPDATE app_settings SET value = '30' WHERE key = 'edit_window_days'").run();
		seed(db, { holidayYears: [2026] });

		const row = db.prepare("SELECT value FROM app_settings WHERE key = 'edit_window_days'").get() as {
			value: string;
		};
		expect(row.value).to.equal("30");
	});

	it("generates holidays for the requested years only once", () => {
		const first = seed(db, { holidayCountry: "CH", holidayYears: [2026] });
		expect(first.holidays).to.equal(5);

		const second = seed(db, { holidayCountry: "CH", holidayYears: [2026] });
		expect(second.holidays).to.equal(0);

		const rows = db.prepare("SELECT date, region FROM holidays ORDER BY date").all() as {
			date: string;
			region: string;
		}[];
		expect(rows).to.have.lengthOf(5);
		expect(rows.every(row => row.region === "CH")).to.equal(true);
		expect(rows.map(row => row.date)).to.include("2026-04-03");
	});

	it("is idempotent for roles and role permissions", () => {
		seed(db, { holidayYears: [2026] });
		const before = (db.prepare("SELECT COUNT(*) AS c FROM role_permissions").get() as { c: number }).c;
		seed(db, { holidayYears: [2026] });
		const after = (db.prepare("SELECT COUNT(*) AS c FROM role_permissions").get() as { c: number }).c;
		expect(after).to.equal(before);
	});
});
