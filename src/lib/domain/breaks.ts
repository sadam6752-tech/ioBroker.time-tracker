/**
 * Break rules (graduated pauses).
 *
 * A break is deducted **per punch pair**, not once per day: every complete pair is
 * checked against the graduated rules, so a day with several pairs can trigger several deductions.
 */

/** A graduated break rule: from a pair duration of `fromMin` minutes, `pauseMin` minutes are deducted. */
export interface PauseRule {
	/** Rule applies from this pair duration in minutes (inclusive) */
	fromMin: number;
	/** Rule applies below this pair duration in minutes (exclusive); `null` = open end */
	toMin?: number | null;
	/** Minutes deducted from the pair */
	pauseMin: number;
	/** Inactive rules are ignored */
	isActive?: boolean;
}

/** Break deduction of a single pair. */
export interface PairBreak {
	/** Index of the pair inside the day */
	pairIndex: number;
	/** Gross duration of the pair in minutes */
	pairMinutes: number;
	/** Deducted break minutes */
	pauseMin: number;
	/** Rule that matched, `null` when no rule applied */
	rule: PauseRule | null;
}

/** Result of applying the break rules to all pairs of a day. */
export interface BreakResult {
	/** Deduction per pair in chronological order */
	perPair: PairBreak[];
	/** Total deducted minutes */
	breakMinutes: number;
	/** Sum of the pair durations before deductions */
	grossMinutes: number;
	/** Sum of the pair durations after deductions */
	workedMinutes: number;
}

/**
 * Finds the first matching active rule for a pair duration (rules are sorted by `fromMin`).
 *
 * @param pairMinutes - gross duration of the pair in minutes
 * @param rules - graduated rules
 * @returns matching rule or `null`
 */
export function pauseRuleForPair(pairMinutes: number, rules: PauseRule[]): PauseRule | null {
	const active = rules
		.filter(rule => rule.isActive !== false && rule.pauseMin > 0)
		.slice()
		.sort((a, b) => a.fromMin - b.fromMin);

	for (const rule of active) {
		const withinStart = pairMinutes >= rule.fromMin;
		const withinEnd = rule.toMin == null || pairMinutes < rule.toMin;
		if (withinStart && withinEnd) {
			return rule;
		}
	}
	return null;
}

/**
 * Applies the break rules to all pairs of one day.
 *
 * @param pairs - pairs with their gross duration in minutes
 * @param rules - graduated rules
 * @returns per-pair deductions and the totals
 */
export function applyPauses(pairs: { minutes: number }[], rules: PauseRule[]): BreakResult {
	const perPair: PairBreak[] = pairs.map((pair, index) => {
		const rule = pauseRuleForPair(pair.minutes, rules);
		// never deduct more than the pair itself
		const pauseMin = rule ? Math.min(rule.pauseMin, pair.minutes) : 0;
		return { pairIndex: index, pairMinutes: pair.minutes, pauseMin, rule };
	});

	const grossMinutes = perPair.reduce((sum, entry) => sum + entry.pairMinutes, 0);
	const breakMinutes = perPair.reduce((sum, entry) => sum + entry.pauseMin, 0);

	return {
		perPair,
		breakMinutes,
		grossMinutes,
		workedMinutes: grossMinutes - breakMinutes,
	};
}

/** How the pause of a day is determined. */
export type PauseMode = "auto" | "punched" | "staffel";

/** Where the pause of a day came from. */
export type PauseSource = "punched" | "staffel" | "none";

/**
 * Decides which pause a day carries.
 *
 * - `punched`: the breaks the employee punched (the time between two pairs of punches)
 * - `staffel`: the graduated rules, deducted per pair
 * - `auto`: the punched breaks as soon as there are any, otherwise the rules — so a day without a punched break
 *   still gets its statutory deduction
 *
 * A day with an open punch never counts as measured: its breaks are not final yet, so the rules apply.
 *
 * @param input - mode, measured break and rule deduction of one day
 * @param input.mode - chosen mode of the instance
 * @param input.gapMinutes - minutes between the pairs of the day
 * @param input.staffelMinutes - minutes the graduated rules deduct
 * @param input.hasOpenEntry - true while the day has an open punch
 * @returns the pause of the day and where it came from
 */
export function effectivePause(input: {
	mode: PauseMode;
	gapMinutes: number;
	staffelMinutes: number;
	hasOpenEntry?: boolean;
}): { pauseMinutes: number; source: PauseSource } {
	const punched = input.gapMinutes > 0 && input.hasOpenEntry !== true;
	if (punched) {
		if (input.mode === "punched" || input.mode === "auto") {
			return { pauseMinutes: input.gapMinutes, source: "punched" };
		}
	}
	if (input.mode === "punched") {
		// measured breaks only: a day without them carries no pause at all
		return { pauseMinutes: 0, source: "none" };
	}
	return input.staffelMinutes > 0
		? { pauseMinutes: input.staffelMinutes, source: "staffel" }
		: { pauseMinutes: 0, source: "none" };
}
