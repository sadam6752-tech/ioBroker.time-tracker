/**
 * Administration: TriggersTab, AutomationRulesCard (split out of `Admin.tsx`).
 */

import { ActionRow } from "../../components/ActionRow";
import AddIcon from "@mui/icons-material/Add";
import { type AdminUser } from "../../api/types";
import Alert from "@mui/material/Alert";
import { type AutomationRule, type AutomationRun, type TriggerRule, api, formatDate } from "../../api/client";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import DeleteIcon from "@mui/icons-material/Delete";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import { ErrorAlert } from "../../components/feedback";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { hasPermission, useSession } from "../../state/session";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatStamp, toggleWeekday, weekdayOptions } from "./helpers";

/**
 * Trigger rules: a state of another adapter punches or sets the presence.
 *
 * The table is edited and saved as a whole, like the break rules of the company. The adapter itself subscribes to
 * the states named here, so a fingerprint reader, a button or a door contact needs no script — and a rule fires
 * only when the value of its state changes.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the trigger tab
 */
export function TriggersTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const { permissions } = useSession();
	const mayEdit = hasPermission(permissions, "settings.edit");
	const queryClient = useQueryClient();
	const rules = useQuery({ queryKey: ["admin", "triggerRules"], queryFn: () => api.triggerRules() });
	const people = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users() });
	// `null` shows what the server has; the first change keeps a local copy until it is saved
	const [draft, setDraft] = useState<TriggerRule[] | null>(null);
	const shown = draft ?? rules.data ?? [];

	const save = useMutation({
		mutationFn: (list: TriggerRule[]) => api.saveTriggerRules(list),
		onSuccess: async () => {
			setDraft(null);
			await queryClient.invalidateQueries({ queryKey: ["admin", "triggerRules"] });
		},
	});

	/**
	 * Merges a change into one rule.
	 *
	 * @param index - position of the rule in the table
	 * @param patch - fields that changed
	 */
	const change = (index: number, patch: Partial<TriggerRule>): void =>
		setDraft(shown.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)));

	/**
	 * Text of the last fire of a rule.
	 *
	 * @param rule - rule to describe
	 * @returns text for the row
	 */
	const lastFired = (rule: TriggerRule): string =>
		rule.lastFiredAt
			? `${t("admin.trigger.lastFired")}: ${formatStamp(rule.lastFiredAt, language)}`
			: t("common.none");

	return (
		<>
			<ErrorAlert error={rules.error ?? save.error} />
			{save.isSuccess && (
				<Alert
					severity="success"
					sx={{ mb: 2 }}
				>
					{t("admin.settings.saved")}
				</Alert>
			)}

			<Card>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.triggers")}
					</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
						gutterBottom
					>
						{t("admin.triggersHint")}
					</Typography>
					<Stack spacing={2}>
						{shown.map((rule, index) => (
							<Stack
								key={rule.id ?? `new-${index}`}
								spacing={1}
								sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1 }}
							>
								<Stack
									direction="row"
									spacing={1}
									useFlexGap
									sx={{ alignItems: "center", flexWrap: "wrap" }}
								>
									<TextField
										size="small"
										label={t("admin.trigger.label")}
										value={rule.label ?? ""}
										onChange={event => change(index, { label: event.target.value })}
										disabled={!mayEdit}
										sx={{ minWidth: 160 }}
									/>
									<TextField
										size="small"
										label={t("admin.trigger.sourceState")}
										value={rule.sourceState}
										onChange={event => change(index, { sourceState: event.target.value })}
										disabled={!mayEdit}
										sx={{ minWidth: 260 }}
									/>
									<TextField
										select
										size="small"
										label={t("admin.trigger.mode")}
										value={rule.mode ?? "condition"}
										onChange={event =>
											change(index, { mode: event.target.value as TriggerRule["mode"] })
										}
										disabled={!mayEdit}
										sx={{ minWidth: 200 }}
									>
										<MenuItem value="condition">{t("admin.trigger.modeCondition")}</MenuItem>
										<MenuItem value="user">{t("admin.trigger.modeUser")}</MenuItem>
									</TextField>
									{(rule.mode ?? "condition") === "condition" && (
										<>
											<TextField
												size="small"
												label={t("admin.trigger.condition")}
												helperText={t("admin.trigger.conditionHint")}
												value={rule.condition ?? ""}
												onChange={event => change(index, { condition: event.target.value })}
												disabled={!mayEdit}
												sx={{ minWidth: 170 }}
											/>
											<TextField
												select
												size="small"
												label={t("admin.trigger.user")}
												value={
													rule.userId === null || rule.userId === undefined
														? ""
														: String(rule.userId)
												}
												onChange={event =>
													change(index, {
														userId:
															event.target.value === ""
																? null
																: Number(event.target.value),
													})
												}
												disabled={!mayEdit}
												sx={{ minWidth: 190 }}
											>
												{(people.data ?? []).map(user => (
													<MenuItem
														key={user.id}
														value={String(user.id)}
													>
														{user.displayName}
													</MenuItem>
												))}
											</TextField>
										</>
									)}
									<TextField
										select
										size="small"
										label={t("admin.trigger.action")}
										value={rule.action ?? "punch"}
										onChange={event =>
											change(index, { action: event.target.value as TriggerRule["action"] })
										}
										disabled={!mayEdit}
										sx={{ minWidth: 230 }}
									>
										<MenuItem value="punch">{t("admin.trigger.actionPunch")}</MenuItem>
										<MenuItem value="quickPunch">{t("admin.trigger.actionQuickPunch")}</MenuItem>
										<MenuItem value="present">{t("admin.trigger.actionPresent")}</MenuItem>
										<MenuItem value="absent">{t("admin.trigger.actionAbsent")}</MenuItem>
									</TextField>
									<TextField
										size="small"
										type="number"
										label={t("admin.trigger.cooldown")}
										value={String(rule.cooldownSec ?? 0)}
										onChange={event => change(index, { cooldownSec: Number(event.target.value) })}
										disabled={!mayEdit}
										sx={{ maxWidth: 140 }}
									/>
									<Switch
										checked={rule.isActive !== false}
										title={t("admin.trigger.active")}
										onChange={() => change(index, { isActive: rule.isActive === false })}
										disabled={!mayEdit}
									/>
									<IconButton
										size="small"
										title={t("admin.tag.delete")}
										disabled={!mayEdit}
										onClick={() => setDraft(shown.filter((_, position) => position !== index))}
									>
										<DeleteIcon fontSize="small" />
									</IconButton>
								</Stack>
								<Typography
									variant="caption"
									color="text.secondary"
								>
									{lastFired(rule)}
								</Typography>
							</Stack>
						))}
						<Stack
							direction="row"
							spacing={1}
							useFlexGap
							sx={{ alignItems: "center", flexWrap: "wrap" }}
						>
							<Button
								size="small"
								startIcon={<AddIcon />}
								disabled={!mayEdit}
								onClick={() =>
									setDraft([
										...shown,
										{
											sourceState: "",
											mode: "condition",
											condition: "true",
											action: "punch",
											isActive: true,
											cooldownSec: 0,
										},
									])
								}
							>
								{t("admin.trigger.add")}
							</Button>
							<Button
								size="small"
								variant="contained"
								disabled={!mayEdit || save.isPending || draft === null}
								onClick={() => save.mutate(shown)}
							>
								{t("common.save")}
							</Button>
						</Stack>
						{!rules.isLoading && shown.length === 0 && (
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("admin.trigger.empty")}
							</Typography>
						)}
					</Stack>
				</CardContent>
			</Card>
		</>
	);
}

/**
 * List of the automation rules: what the adapter does on its own.
 *
 * Every rule is one row — caption, kind, time, target and weekdays at a glance, with the actions on the right. The
 * rows are edited in a dialog, so the list stays readable and the form only appears for the rule that is worked on.
 * Each row also names its newest run, so the administration can see whether a rule works the way it is meant to.
 *
 * @param props - rules, runs, employees, permission and handlers
 * @param props.rules - rules as they are shown
 * @param props.runs - newest run of every rule (one row per rule)
 * @param props.people - employees a rule can be limited to
 * @param props.disabled - true when the caller may not change them
 * @param props.saving - true while a save is running
 * @param props.onChange - called with the changed table
 * @param props.onSave - saves the table
 * @param props.language - language of the display
 * @returns the editor
 */
export function AutomationRulesCard({
	rules,
	runs,
	people,
	disabled,
	saving,
	onChange,
	onSave,
	language,
}: {
	rules: AutomationRule[];
	runs: AutomationRun[];
	people: AdminUser[];
	disabled: boolean;
	saving: boolean;
	onChange: (rules: AutomationRule[]) => void;
	onSave: () => void;
	language: string;
}): React.JSX.Element {
	const { t } = useTranslation();

	/** Position of the rule the dialog edits, `null` while the dialog is closed. */
	const [editing, setEditing] = useState<number | null>(null);
	/** Copy the dialog works on, so closing it without saving changes nothing. */
	const [draft, setDraft] = useState<AutomationRule | null>(null);
	/** True while the dialog shows a rule that was just added to the list. */
	const [isNew, setIsNew] = useState(false);

	/**
	 * Opens the dialog for one rule.
	 *
	 * @param index - position of the rule in the table
	 * @param rule - rule to edit; taken from the table when it is left out
	 */
	const openEditor = (index: number, rule?: AutomationRule): void => {
		setDraft(rule ? { ...rule } : { ...rules[index] });
		setIsNew(rule !== undefined);
		setEditing(index);
	};

	/**
	 * Name of the kind of a rule, as a row shows it.
	 *
	 * @param kind - kind of the rule
	 * @returns translated name
	 */
	const kindLabel = (kind: AutomationRule["kind"]): string =>
		t(`admin.automation.kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`);

	/**
	 * Weekdays of a rule as a short text.
	 *
	 * @param weekdays - weekdays the rule runs on
	 * @returns the names of the days, or an empty text when the rule runs on every day
	 */
	const weekdaySummary = (weekdays: number[]): string => {
		const names = weekdayOptions(language);
		if (weekdays.length >= 7) {
			// all seven days are no limitation: the row already says “once a day” or “once a week”, and repeating
			// that text here would be the same sentence twice
			return "";
		}
		return weekdays.map(value => names.find(option => option.value === value)?.label ?? String(value)).join(", ");
	};

	/**
	 * Validity period of a rule as a short text, empty when the rule is not limited.
	 *
	 * @param rule - rule to describe
	 * @returns the period, or an empty string when the rule is valid without an end
	 */
	const validitySummary = (rule: AutomationRule): string => {
		const from = rule.activeFrom ? formatDate(rule.activeFrom, language) : "";
		const until = rule.activeUntil ? formatDate(rule.activeUntil, language) : "";
		if (from && until) {
			return t("admin.automation.validityRange", { from, until });
		}
		if (from) {
			return t("admin.automation.validityFrom", { date: from });
		}
		return until ? t("admin.automation.validityUntil", { date: until }) : "";
	};

	/**
	 * Merges a change into one rule.
	 *
	 * @param index - position of the rule in the table
	 * @param patch - fields that changed
	 */
	const change = (index: number, patch: Partial<AutomationRule>): void =>
		onChange(rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)));

	/** Writes the draft back into the table and closes the dialog. */
	const applyDraft = (): void => {
		if (editing !== null && draft) {
			change(editing, draft);
		}
		setEditing(null);
		setDraft(null);
	};

	/**
	 * Writes a minute of the day as a time.
	 *
	 * @param minute - minutes since midnight, `null` renders `00:00`
	 * @returns `HH:MM`
	 */
	const timeOf = (minute: number | null | undefined): string => {
		const value = minute ?? 0;
		return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
	};

	/**
	 * Reads a time out of a field.
	 *
	 * @param value - text of the field
	 * @returns minutes since midnight, `null` when the text is not a time
	 */
	const minutesOf = (value: string): number | null => {
		const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
		if (!match) {
			return null;
		}
		const hours = Number(match[1]);
		const minutes = Number(match[2]);
		return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59 ? hours * 60 + minutes : null;
	};

	/**
	 * Name of the employee a run belongs to.
	 *
	 * @param id - user id
	 * @returns shown name
	 */
	const nameOf = (id: number): string => people.find(user => user.id === id)?.displayName ?? `#${id}`;

	/**
	 * The newest run of a rule as one line.
	 *
	 * The server sends one run per rule, so a rule that has not run yet gets the hint instead of a date.
	 *
	 * @param rule - rule to describe
	 * @returns stamp and employee of the last run, or the “never ran” text
	 */
	const lastRunOf = (rule: AutomationRule): string => {
		const found = rule.id === undefined ? undefined : runs.find(candidate => candidate.ruleId === rule.id);
		return found
			? `${t("admin.automation.runs")}: ${formatStamp(found.firedAt, language)} · ${nameOf(found.userId)}`
			: t("admin.automation.neverRun");
	};

	return (
		<Card
			sx={{ mb: 2 }}
			data-testid="automation-rules"
		>
			<CardContent>
				<Typography
					variant="subtitle1"
					gutterBottom
				>
					{t("admin.settings.automations")}
				</Typography>
				<Typography
					variant="body2"
					color="text.secondary"
					gutterBottom
				>
					{t("admin.settings.automationsHint")}
				</Typography>
				<Stack spacing={1}>
					{rules.map((rule, index) => (
						<ActionRow
							key={rule.id ?? `new-${index}`}
							primary={rule.label?.trim() ? rule.label : kindLabel(rule.kind)}
							secondary={
								<>
									{[
										kindLabel(rule.kind),
										rule.kind === "breakReminder"
											? `${t("admin.automation.after")} ${rule.afterMinutes ?? 360}`
											: timeOf(rule.atMinute),
										rule.userId === null || rule.userId === undefined
											? t("admin.automation.allUsers")
											: nameOf(rule.userId),
										weekdaySummary(rule.weekdays ?? [1, 2, 3, 4, 5, 6, 7]),
										t(
											rule.repeat === "week"
												? "admin.automation.repeatWeek"
												: "admin.automation.repeatDay",
										),
										validitySummary(rule),
									]
										.filter(part => part !== "")
										.join(" · ")}
									<br />
									{lastRunOf(rule)}
								</>
							}
						>
							<Button
								size="small"
								disabled={disabled}
								color={rule.isActive === false ? "inherit" : "primary"}
								onClick={() => change(index, { isActive: rule.isActive === false })}
							>
								{t("admin.trigger.active")}
							</Button>
							<Button
								size="small"
								disabled={disabled}
								onClick={() => openEditor(index)}
							>
								{t("admin.automation.edit")}
							</Button>
							<IconButton
								size="small"
								title={t("admin.tag.delete")}
								disabled={disabled}
								onClick={() => onChange(rules.filter((_, position) => position !== index))}
							>
								<DeleteIcon fontSize="small" />
							</IconButton>
						</ActionRow>
					))}
					<Stack
						direction="row"
						spacing={1}
						useFlexGap
						sx={{ alignItems: "center", flexWrap: "wrap" }}
					>
						<Button
							size="small"
							startIcon={<AddIcon />}
							disabled={disabled}
							onClick={() => {
								// the new rule opens right away, so it can be filled in without a second click
								const created: AutomationRule = {
									kind: "clockOut",
									atMinute: 20 * 60,
									userId: null,
									weekdays: [1, 2, 3, 4, 5, 6, 7],
									repeat: "day",
									isActive: true,
									activeFrom: null,
									activeUntil: null,
								};
								onChange([...rules, created]);
								openEditor(rules.length, created);
							}}
						>
							{t("admin.automation.add")}
						</Button>
						<Button
							size="small"
							variant="contained"
							disabled={disabled || saving}
							onClick={onSave}
						>
							{t("admin.automation.save")}
						</Button>
					</Stack>
					<Typography
						variant="body2"
						color="text.secondary"
					>
						{t("admin.automation.saveHint")}
					</Typography>
					{rules.length === 0 && (
						<Typography
							variant="body2"
							color="text.secondary"
						>
							{t("admin.automation.empty")}
						</Typography>
					)}
				</Stack>
				{/* The dialog edits one rule; the list behind it stays visible and unchanged until it is saved. */}
				<Dialog
					open={draft !== null}
					onClose={() => {
						setEditing(null);
						setDraft(null);
					}}
					fullWidth
					maxWidth="sm"
				>
					<DialogTitle>{t(isNew ? "admin.automation.newTitle" : "admin.automation.editTitle")}</DialogTitle>
					<DialogContent>
						{draft && (
							<Stack
								spacing={1.5}
								sx={{ mt: 1 }}
							>
								<TextField
									size="small"
									label={t("admin.trigger.label")}
									value={draft.label ?? ""}
									onChange={event => setDraft({ ...draft, label: event.target.value })}
									disabled={disabled}
									fullWidth
								/>
								<TextField
									select
									size="small"
									label={t("admin.automation.kind")}
									value={draft.kind}
									onChange={event =>
										setDraft({ ...draft, kind: event.target.value as AutomationRule["kind"] })
									}
									disabled={disabled}
									fullWidth
								>
									<MenuItem value="clockIn">{t("admin.automation.kindClockIn")}</MenuItem>
									<MenuItem value="clockOut">{t("admin.automation.kindClockOut")}</MenuItem>
									<MenuItem value="missingPunch">{t("admin.automation.kindMissingPunch")}</MenuItem>
									<MenuItem value="breakReminder">{t("admin.automation.kindBreakReminder")}</MenuItem>
								</TextField>
								{draft.kind === "breakReminder" ? (
									<TextField
										size="small"
										type="number"
										label={t("admin.automation.after")}
										value={String(draft.afterMinutes ?? 360)}
										onChange={event =>
											setDraft({ ...draft, afterMinutes: Number(event.target.value) })
										}
										disabled={disabled}
										fullWidth
									/>
								) : (
									<TextField
										size="small"
										label={t("admin.automation.at")}
										helperText={t("admin.automation.atHint")}
										value={timeOf(draft.atMinute)}
										onChange={event => {
											const minute = minutesOf(event.target.value);
											if (minute !== null) {
												setDraft({ ...draft, atMinute: minute });
											}
										}}
										disabled={disabled}
										fullWidth
									/>
								)}
								<TextField
									select
									size="small"
									label={t("admin.automation.user")}
									value={
										draft.userId === null || draft.userId === undefined ? "" : String(draft.userId)
									}
									onChange={event =>
										setDraft({
											...draft,
											userId: event.target.value === "" ? null : Number(event.target.value),
										})
									}
									disabled={disabled}
									fullWidth
								>
									<MenuItem value="">{t("admin.automation.allUsers")}</MenuItem>
									{people.map(user => (
										<MenuItem
											key={user.id}
											value={String(user.id)}
										>
											{user.displayName}
										</MenuItem>
									))}
								</TextField>
								<Box>
									<Typography
										variant="body2"
										color="text.secondary"
									>
										{t("admin.automation.weekdays")}
									</Typography>
									<Stack
										direction="row"
										spacing={1}
										useFlexGap
										sx={{ alignItems: "center", flexWrap: "wrap" }}
									>
										{weekdayOptions(language).map(option => (
											<FormControlLabel
												key={option.value}
												control={
													<Checkbox
														size="small"
														checked={draft.weekdays?.includes(option.value) ?? true}
														onChange={event =>
															setDraft({
																...draft,
																weekdays: toggleWeekday(
																	draft.weekdays ?? [1, 2, 3, 4, 5, 6, 7],
																	option.value,
																	event.target.checked,
																),
															})
														}
														disabled={disabled}
													/>
												}
												label={option.label}
											/>
										))}
									</Stack>
								</Box>
								<Stack
									direction="row"
									spacing={1}
									useFlexGap
									sx={{ alignItems: "center", flexWrap: "wrap" }}
								>
									<TextField
										select
										size="small"
										label={t("admin.automation.repeat")}
										value={draft.repeat ?? "day"}
										onChange={event =>
											setDraft({
												...draft,
												repeat: event.target.value as AutomationRule["repeat"],
											})
										}
										disabled={disabled}
										sx={{ minWidth: 190 }}
									>
										<MenuItem value="day">{t("admin.automation.repeatDay")}</MenuItem>
										<MenuItem value="week">{t("admin.automation.repeatWeek")}</MenuItem>
									</TextField>
									<Button
										size="small"
										color={draft.isActive === false ? "inherit" : "primary"}
										onClick={() => setDraft({ ...draft, isActive: draft.isActive === false })}
										disabled={disabled}
									>
										{t("admin.trigger.active")}
									</Button>
								</Stack>
								<Stack
									direction="row"
									spacing={1}
									useFlexGap
									sx={{ alignItems: "flex-start", flexWrap: "wrap" }}
								>
									<TextField
										size="small"
										type="date"
										label={t("admin.automation.validFrom")}
										helperText={t("admin.automation.validFromHint")}
										value={draft.activeFrom ?? ""}
										onChange={event =>
											setDraft({ ...draft, activeFrom: event.target.value || null })
										}
										disabled={disabled}
										sx={{ minWidth: 200 }}
										InputLabelProps={{ shrink: true }}
									/>
									<TextField
										size="small"
										type="date"
										label={t("admin.automation.validUntil")}
										helperText={t("admin.automation.validUntilHint")}
										value={draft.activeUntil ?? ""}
										onChange={event =>
											setDraft({ ...draft, activeUntil: event.target.value || null })
										}
										disabled={disabled}
										sx={{ minWidth: 200 }}
										InputLabelProps={{ shrink: true }}
									/>
								</Stack>
							</Stack>
						)}
					</DialogContent>
					<DialogActions>
						<Button
							onClick={() => {
								setEditing(null);
								setDraft(null);
							}}
						>
							{t("common.cancel")}
						</Button>
						<Button
							variant="contained"
							onClick={applyDraft}
							disabled={draft === null}
						>
							{t("common.save")}
						</Button>
					</DialogActions>
				</Dialog>
			</CardContent>
		</Card>
	);
}
