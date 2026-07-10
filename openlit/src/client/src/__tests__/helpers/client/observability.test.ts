import {
	defaultTimeRangeForSignal,
	prepareObservabilitySignalChange,
} from "@/helpers/client/observability";
import { DEFAULT_SORTING, filterStoreSlice } from "@/store/filter";
import { withLenses } from "@dhmk/zustand-lens";
import { create } from "zustand";

const createStore = () => create<any>()(withLenses({ filter: filterStoreSlice }));

describe("prepareObservabilitySignalChange", () => {
	it("clears transient grouping state without clearing selected filters", () => {
		const updateConfig = jest.fn();
		const updateFilter = jest.fn();

		prepareObservabilitySignalChange(updateConfig, updateFilter);

		expect(updateConfig).toHaveBeenCalledWith(undefined);
		expect(updateFilter).toHaveBeenCalledWith("groupBy", null);
		expect(updateFilter).not.toHaveBeenCalledWith(
			"selectedConfig",
			expect.anything(),
			expect.anything()
		);
		expect(updateFilter).not.toHaveBeenCalledWith(
			"selectedConfig",
			expect.anything()
		);
	});

	it("preserves selectedConfig when applied to the filter store", () => {
		const store = createStore();

		store.getState().filter.updateFilter("selectedConfig", {
			models: ["gpt-4o-mini"],
			services: ["api"],
		});
		store.getState().filter.updateFilter("groupBy", "serviceName");

		prepareObservabilitySignalChange(
			store.getState().filter.updateConfig,
			store.getState().filter.updateFilter
		);

		expect(store.getState().filter.details.selectedConfig).toEqual({
			models: ["gpt-4o-mini"],
			services: ["api"],
		});
		expect(store.getState().filter.details.groupBy).toBeNull();
	});

	// E3: sort key applied on the previous tab gets reset so the
	// new tab doesn't try to ORDER BY a column it doesn't have.
	it("resets sorting and offset when changing signal", () => {
		const store = createStore();

		store.getState().filter.updateFilter("sorting", {
			type: "Tokens",
			direction: "asc",
		});
		store.getState().filter.updateFilter("offset", 50);

		prepareObservabilitySignalChange(
			store.getState().filter.updateConfig,
			store.getState().filter.updateFilter
		);

		expect(store.getState().filter.details.sorting).toEqual(DEFAULT_SORTING);
		expect(store.getState().filter.details.offset).toBe(0);
	});

	// Regression: coding-agent sessions are browsed historically (a
	// developer's last coding session is routinely days old), so the
	// global 24h default rendered the Sessions tab empty on load even
	// though every span was retained.
	it("switches the coding sessions tab to the ALL range", () => {
		const store = createStore();

		prepareObservabilitySignalChange(
			store.getState().filter.updateConfig,
			store.getState().filter.updateFilter,
			"sessions",
			store.getState().filter.details.timeLimit.type
		);

		expect(store.getState().filter.details.timeLimit.type).toBe("ALL");
		expect(store.getState().filter.details.timeLimit.start.getTime()).toBe(0);
	});

	it("does not leak the ALL range onto high-cardinality signals", () => {
		const store = createStore();
		store.getState().filter.updateFilter("timeLimit.type", "ALL");

		prepareObservabilitySignalChange(
			store.getState().filter.updateConfig,
			store.getState().filter.updateFilter,
			"traces",
			store.getState().filter.details.timeLimit.type
		);

		expect(store.getState().filter.details.timeLimit.type).toBe("24H");
	});

	it("leaves a hand-picked range alone when switching between non-coding signals", () => {
		const store = createStore();
		store.getState().filter.updateFilter("timeLimit.type", "7D");

		prepareObservabilitySignalChange(
			store.getState().filter.updateConfig,
			store.getState().filter.updateFilter,
			"traces",
			store.getState().filter.details.timeLimit.type
		);

		expect(store.getState().filter.details.timeLimit.type).toBe("7D");
	});
});

describe("defaultTimeRangeForSignal", () => {
	it("returns ALL for the coding sessions and users signals", () => {
		expect(defaultTimeRangeForSignal("sessions", "24H")).toBe("ALL");
		expect(defaultTimeRangeForSignal("users", "24H")).toBe("ALL");
	});

	it("respects a CUSTOM range the user picked by hand on a coding signal", () => {
		expect(defaultTimeRangeForSignal("sessions", "CUSTOM")).toBeNull();
	});

	it("resets ALL back to the global default when leaving a coding signal", () => {
		expect(defaultTimeRangeForSignal("traces", "ALL")).toBe("24H");
	});

	it("has no opinion about non-coding signals on a normal range", () => {
		expect(defaultTimeRangeForSignal("traces", "7D")).toBeNull();
		expect(defaultTimeRangeForSignal("metrics", "24H")).toBeNull();
		expect(defaultTimeRangeForSignal(undefined, "24H")).toBeNull();
	});
});
