/// <reference types="mocha" />
import { expect } from "chai";
import { DateTime } from "luxon";
import { openAndMigrate, type Db } from "../db/database";
import { seed } from "../db/seed";
import { createAbsencesRepository } from "../db/repositories/absences";
import { createEntriesRepository, type EntriesRepository } from "../db/repositories/entries";
import { createHolidaysRepository } from "../db/repositories/holidays";
import { createRulesRepository } from "../db/repositories/rules";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUsersRepository, type UsersRepository } from "../db/repositories/users";
import { createAggregationService, type AggregationService } from "./aggregation";
import { createSyncService, type SyncService } from "./sync";

const berlin = "Europe/Berlin";

/**
 * Converts a local wall clock time into UTC epoch seconds.
 *
 * @param iso - local date and time, `YYYY-MM-DDTHH:mm`
 * @returns UTC epoch seconds
 */
function utc(iso: string): number {
	return Math.floor(DateTime.fromISO(iso, { zone: berlin }).toSeconds());
}

describe("sync service", () => {
	let db: Db;
	let users: UsersRepository;
	let entries: EntriesRepository;
	let aggregation: AggregationService;
	let service: SyncService;
	let annaId: number;
	let adminId: number;

	/**
	 * Counts the rows of a table.
	 *
	 * @param table - table name
	 * @returns number of rows
	 */
	function countRows(table: string): number {
		return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
	}

	/**
	 * Counts the audit rows of one action.
	 *
	 * @param action - action key
	 * @returns number of rows
	 */
	function countAudit(action: string): number {
		return (db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = ?").get(action) as { count: number })
			.count;
	}

	beforeEach(() => {
		db = openAndMigrate(":memory:");
		seed(db, { holidayYears: [2026] });
		users = createUsersRepository(db);
		entries = createEntriesRepository(db);
		aggregation = createAggregationService({
			db,
			users,
			entries,
			absences: createAbsencesRepository(db),
			holidays: createHolidaysRepository(db),
			rules: createRulesRepository(db),
			settings: createSettingsRepository(db),
		});
		service = createSyncService({ db, entries, users, aggregation });

		adminId = users.create({ login: "admin", displayName: "Admin", roleKeys: ["admin"] }).id;
		annaId = users.create({ login: "anna", displayName: "Anna", roleKeys: ["employee"] }).id;
		users.saveWorkProfile({
			userId: annaId,
			profile: { percent: 100, weeklyHours: 40, workdays: "0;1;1;1;1;1;0" },
			actorId: adminId,
		});
	});

	afterEach(() => {
		db.close();
	});

	describe("batch", () => {
		it("accepts a batch, sorts it and refreshes the affected days", () => {
			const result = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [
					{ idempotencyKey: "d", tsUtc: utc("2026-01-07T17:00") },
					{ idempotencyKey: "b", tsUtc: utc("2026-01-07T12:00") },
					{ idempotencyKey: "a", tsUtc: utc("2026-01-07T08:00") },
					{ idempotencyKey: "c", tsUtc: utc("2026-01-07T13:00") },
				],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});

			expect(result.conflicts).to.deep.equal([]);
			expect(result.rejected).to.deep.equal([]);
			expect(result.accepted.map(entry => entry.idempotencyKey)).to.deep.equal(["a", "b", "c", "d"]);
			expect(result.accepted.every(entry => entry.created)).to.equal(true);
			expect(result.accepted.every(entry => entry.syncState === "synced")).to.equal(true);
			expect(result.accepted.every(entry => entry.localDate === "2026-01-07")).to.equal(true);
			expect(result.recalculated).to.deep.equal(["2026-01-07"]);
			expect(aggregation.day(annaId, "2026-01-07")?.workedMin).to.equal(480);
		});

		it("is idempotent for a repeated batch", () => {
			const batch = {
				userId: annaId,
				timeZone: berlin,
				punches: [
					{ idempotencyKey: "a", tsUtc: utc("2026-01-07T08:00") },
					{ idempotencyKey: "b", tsUtc: utc("2026-01-07T12:00") },
				],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			};

			const first = service.sync(batch);
			const second = service.sync(batch);

			expect(first.accepted.every(entry => entry.created)).to.equal(true);
			expect(second.accepted.every(entry => entry.created)).to.equal(false);
			expect(second.conflicts).to.deep.equal([]);
			expect(second.accepted.map(entry => entry.entryId)).to.deep.equal(
				first.accepted.map(entry => entry.entryId),
			);
			expect(countRows("time_entries")).to.equal(2);
			// only the first transfer is audited as a creation
			const creations = db
				.prepare("SELECT COUNT(*) AS count FROM time_entry_audit WHERE action = 'create'")
				.get() as { count: number };
			expect(creations.count).to.equal(2);
		});
	});

	describe("conflicts", () => {
		it("stores a punch with a clock skew as conflict", () => {
			const result = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [
					{
						idempotencyKey: "skewed",
						tsUtc: utc("2026-01-07T08:00"),
						clientTsUtc: utc("2026-01-07T08:00") - 900,
					},
				],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});

			expect(result.accepted).to.deep.equal([]);
			expect(result.conflicts).to.have.lengthOf(1);
			expect(result.conflicts[0].reason).to.equal("clock_skew");
			expect(result.conflicts[0].entry?.syncState).to.equal("conflict");
			// the punch is kept, but it does not count in the calculation
			expect(countRows("time_entries")).to.equal(1);
			expect(aggregation.day(annaId, "2026-01-07")?.workedMin).to.equal(0);
			expect(service.conflicts(annaId).map(entry => entry.idempotencyKey)).to.deep.equal(["skewed"]);

			// a small skew is accepted
			const tolerated = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [
					{
						idempotencyKey: "ok",
						tsUtc: utc("2026-01-07T12:00"),
						clientTsUtc: utc("2026-01-07T12:00") - 60,
					},
				],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});
			expect(tolerated.accepted).to.have.lengthOf(1);
			expect(tolerated.conflicts).to.deep.equal([]);
		});

		it("stores a punch outside the employment window as conflict", () => {
			users.saveWorkProfile({
				userId: annaId,
				profile: { endDate: utc("2026-01-05T23:00") },
				actorId: adminId,
			});

			const result = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [{ idempotencyKey: "late", tsUtc: utc("2026-01-07T08:00") }],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});

			expect(result.conflicts).to.have.lengthOf(1);
			expect(result.conflicts[0].reason).to.equal("employment_window");
			expect(result.conflicts[0].entry?.syncState).to.equal("conflict");
		});

		it("reports a duplicate punch without storing it", () => {
			entries.insert({
				userId: annaId,
				tsUtc: utc("2026-01-07T08:00"),
				timeZone: berlin,
				source: "web",
				idempotencyKey: "original",
			});

			const result = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [{ idempotencyKey: "offline-copy", tsUtc: utc("2026-01-07T08:00") + 10 }],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});

			expect(result.conflicts).to.have.lengthOf(1);
			expect(result.conflicts[0]).to.deep.include({ reason: "duplicate_punch", entryId: null, entry: null });
			expect(countRows("time_entries")).to.equal(1);
		});

		it("rejects punches that are unusable or far in the future", () => {
			const result = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [
					{ idempotencyKey: "   ", tsUtc: utc("2026-01-07T08:00") },
					{ idempotencyKey: "broken", tsUtc: Number.NaN },
					{ idempotencyKey: "future", tsUtc: utc("2026-01-09T08:00") },
				],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});

			expect(result.accepted).to.deep.equal([]);
			expect(result.conflicts).to.deep.equal([]);
			expect(result.rejected.map(entry => entry.reason)).to.deep.equal(["missing_key", "invalid", "future"]);
			expect(countRows("time_entries")).to.equal(0);
		});
	});

	describe("resolve", () => {
		it("accepts a conflict with a corrected instant and refreshes the day", () => {
			const conflicted = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [
					{
						idempotencyKey: "skewed",
						tsUtc: utc("2026-01-07T08:00"),
						clientTsUtc: utc("2026-01-07T08:00") - 1800,
					},
				],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});
			const entryId = conflicted.conflicts[0].entryId ?? 0;

			const resolved = service.resolve({
				entryId,
				action: "accept",
				tsUtc: utc("2026-01-07T07:00"),
				reason: "device clock was wrong",
				actorId: adminId,
				now: utc("2026-01-07T21:00"),
			});

			expect(resolved.action).to.equal("accept");
			expect(resolved.entry?.tsUtc).to.equal(utc("2026-01-07T07:00"));
			expect(resolved.entry?.syncState).to.equal("synced");
			expect(resolved.recalculated).to.deep.equal(["2026-01-07"]);
			expect(service.conflicts(annaId)).to.deep.equal([]);
			expect(countAudit("entry.conflict_accept")).to.equal(1);
			expect(countAudit("entry.sync_state")).to.equal(1);
			// the corrected punch now counts (still an open punch without a counterpart)
			expect(aggregation.day(annaId, "2026-01-07")?.hasOpenEntry).to.equal(true);
		});

		it("accepts a conflict without changing the instant", () => {
			const conflicted = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [
					{
						idempotencyKey: "skewed",
						tsUtc: utc("2026-01-07T08:00"),
						clientTsUtc: utc("2026-01-07T08:00") - 1800,
					},
				],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});
			expect(conflicted.conflicts).to.have.lengthOf(1);
			const entryId = conflicted.conflicts[0].entryId ?? 0;

			const resolved = service.resolve({ entryId, action: "accept", actorId: adminId });

			expect(resolved.entry?.syncState).to.equal("synced");
			// the instant is kept as it came in
			expect(resolved.entry?.tsUtc).to.equal(utc("2026-01-07T08:00"));
			expect(resolved.recalculated).to.deep.equal(["2026-01-07"]);
		});

		it("dismisses a conflict and deletes the punch", () => {
			const conflicted = service.sync({
				userId: annaId,
				timeZone: berlin,
				punches: [
					{
						idempotencyKey: "skewed",
						tsUtc: utc("2026-01-07T08:00"),
						clientTsUtc: utc("2026-01-07T08:00") - 1800,
					},
				],
				actorId: annaId,
				now: utc("2026-01-07T20:00"),
			});
			const entryId = conflicted.conflicts[0].entryId ?? 0;

			const resolved = service.resolve({
				entryId,
				action: "dismiss",
				reason: "punch was accidental",
				actorId: adminId,
			});

			expect(resolved.entry).to.equal(null);
			expect(resolved.recalculated).to.deep.equal(["2026-01-07"]);
			expect(entries.findById(entryId)).to.equal(null);
			expect(countRows("time_entries")).to.equal(0);
			expect(countAudit("entry.conflict_dismiss")).to.equal(1);
			expect(countAudit("entry.delete")).to.equal(1);
		});

		it("refuses to resolve punches that are not in conflict", () => {
			const stored = entries.insert({
				userId: annaId,
				tsUtc: utc("2026-01-07T08:00"),
				timeZone: berlin,
				source: "web",
			}).entry;

			expect(() => service.resolve({ entryId: stored.id, action: "accept", actorId: adminId })).to.throw(
				"is not in conflict",
			);
			expect(() => service.resolve({ entryId: 999, action: "accept", actorId: adminId })).to.throw(
				"entry 999 not found",
			);
		});
	});

	describe("cancellation pairs", () => {
		/**
		 * Inserts a punch directly into the storage.
		 *
		 * @param iso - local date and time of the punch
		 * @returns id of the punch
		 */
		function insert(iso: string): number {
			return entries.insert({ userId: annaId, tsUtc: utc(iso), timeZone: berlin, source: "web" }).entry.id;
		}

		it("finds neighbouring punches inside the tolerance", () => {
			insert("2026-01-07T08:00");
			insert("2026-01-07T08:00:30");
			insert("2026-01-07T12:00");
			insert("2026-01-07T13:00");
			insert("2026-01-07T13:01:00");

			const pairs = service.findCancellationPairs(annaId, "2026-01-06", "2026-01-08");

			expect(pairs).to.have.lengthOf(2);
			expect(pairs.map(pair => pair.distanceSeconds)).to.deep.equal([30, 60]);
			expect(pairs[0].first.tsUtc).to.equal(utc("2026-01-07T08:00"));

			// a narrower tolerance finds nothing in the second pair any more
			expect(
				service.findCancellationPairs(annaId, "2026-01-06", "2026-01-08", { maxDistanceSeconds: 40 }),
			).to.have.lengthOf(1);
		});

		it("ignores conflicts and other employees", () => {
			insert("2026-01-07T08:00");
			insert("2026-01-07T08:00:30");
			entries.insert({
				userId: annaId,
				tsUtc: utc("2026-01-07T09:00"),
				timeZone: berlin,
				syncState: "conflict",
			});
			entries.insert({
				userId: annaId,
				tsUtc: utc("2026-01-07T09:00:20"),
				timeZone: berlin,
				syncState: "conflict",
			});

			const pairs = service.findCancellationPairs(annaId, "2026-01-06", "2026-01-08");

			// only the two synced punches form a pair
			expect(pairs).to.have.lengthOf(1);
			expect(pairs[0].first.syncState).to.equal("synced");
		});

		it("removes both punches and refreshes the day", () => {
			const first = insert("2026-01-07T08:00");
			const second = insert("2026-01-07T08:00:30");
			insert("2026-01-07T12:00");
			insert("2026-01-07T17:00");
			aggregation.recalculateDay(annaId, "2026-01-07");
			// the 30 seconds between the first two punches round to one minute
			expect(aggregation.day(annaId, "2026-01-07")?.workedMin).to.equal(301);

			const result = service.cancelPair({
				entryIds: [first, second],
				reason: "double punch",
				actorId: adminId,
				now: utc("2026-01-07T21:00"),
			});

			expect(result.removed).to.equal(2);
			expect(result.recalculated).to.deep.equal(["2026-01-07"]);
			expect(entries.findById(first)).to.equal(null);
			expect(entries.findById(second)).to.equal(null);
			expect(countRows("time_entries")).to.equal(2);
			expect(countAudit("entry.cancel_pair")).to.equal(1);
			// the remaining pair of punches is calculated without the cancelled ones
			expect(aggregation.day(annaId, "2026-01-07")?.workedMin).to.equal(300);
		});

		it("rejects incomplete or mixed pairs", () => {
			const first = insert("2026-01-07T08:00");
			const other = entries.insert({
				userId: adminId,
				tsUtc: utc("2026-01-07T08:00:30"),
				timeZone: berlin,
				source: "web",
			}).entry.id;

			expect(() => service.cancelPair({ entryIds: [first, 999], actorId: adminId })).to.throw(
				"both punches of the cancellation pair must exist",
			);
			expect(() => service.cancelPair({ entryIds: [first, other], actorId: adminId })).to.throw(
				"must belong to the same employee",
			);
			expect(countRows("time_entries")).to.equal(2);
		});
	});
});
