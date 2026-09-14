/// <reference types="mocha" />
import { expect } from "chai";
import { createEventBus, type ApiEvent } from "./events";

describe("event bus", () => {
	it("delivers events to every listener and stops after unsubscribe", () => {
		const bus = createEventBus();
		const seen: ApiEvent[] = [];
		const stop = bus.subscribe(event => seen.push(event));
		bus.subscribe(event => seen.push({ ...event, type: "entry.update" }));

		expect(bus.listenerCount()).to.equal(2);
		bus.publish({ type: "punch", atUtc: 1000, userId: 7, data: { entryId: 1 } });
		expect(seen).to.have.length(2);
		expect(seen[0]).to.deep.equal({ type: "punch", atUtc: 1000, userId: 7, data: { entryId: 1 } });

		stop();
		expect(bus.listenerCount()).to.equal(1);
		bus.publish({ type: "punch", atUtc: 2000, userId: 7 });
		expect(seen).to.have.length(3);
	});

	it("keeps the other listeners working when one of them throws", () => {
		const bus = createEventBus();
		const seen: ApiEvent[] = [];
		bus.subscribe(() => {
			throw new Error("kaputt");
		});
		bus.subscribe(event => seen.push(event));

		expect(() => bus.publish({ type: "month.close", atUtc: 1000, userId: null })).to.not.throw();
		expect(seen).to.have.length(1);
	});
});
