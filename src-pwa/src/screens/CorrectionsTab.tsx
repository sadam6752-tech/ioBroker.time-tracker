/**
 * Time corrections: the administration looks at the punches of one employee and fixes them.
 *
 * The everyday case is a forgotten punch: somebody did not clock in or out, so the day — and with it the month — is
 * wrong. Here the administration picks the employee and the month, changes a punch (time, direction, note), removes a
 * punch that was not meant, or adds the missing ones. A whole day can be added at once, which covers “forgot to clock
 * in *and* out”.
 *
 * Every change carries the reason that was typed in: it lands in the audit trail of the adapter, and the added
 * punches are recorded with `source: admin`.
 */

import { useState } from "react";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, formatTime } from "../api/client";
import type { Entry } from "../api/types";
import { ErrorAlert, Loading } from "../components/feedback";
import { monthRange } from "./Month";

/**
 * Offset of a time zone at an instant, in seconds (local wall clock minus UTC).
 *
 * @param instant - instant to look at
 * @param timeZone - IANA name of the zone
 * @returns the offset in seconds
 */
function zoneOffsetSeconds(instant: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(instant);
	const valueOf = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? "0");
	const asUtc = Date.UTC(
		valueOf("year"),
		valueOf("month") - 1,
		valueOf("day"),
		valueOf("hour") % 24,
		valueOf("minute"),
		valueOf("second"),
	);
	return (asUtc - instant.getTime()) / 1000;
}

/**
 * Turns a wall clock of an employee into an instant.
 *
 * The administration types a local time (“08:00” on a date), and the punch has to be stored as a UTC instant. The
 * offset of the zone is looked up twice, which also covers a day on which the clocks are changed.
 *
 * @param date - local date, `YYYY-MM-DD`
 * @param time - local time, `HH:MM`
 * @param timeZone - time zone of the employee
 * @returns the instant in UTC epoch seconds
 */
function localToUtc(date: string, time: string, timeZone: string): number {
	const naive = Date.parse(`${date}T${time}:00Z`);
	const first = naive - zoneOffsetSeconds(new Date(naive), timeZone) * 1000;
	return Math.round((naive - zoneOffsetSeconds(new Date(first), timeZone) * 1000) / 1000);
}

/**
 * Formats the day and the time of a punch for the list.
 *
 * @param tsUtc - instant of the punch, UTC epoch seconds
 * @param timeZone - time zone of the employee
 * @param locales - language of the display
 * @returns weekday, date and time
 */
function formatPunch(tsUtc: number, timeZone: string, locales: string): string {
	return new Intl.DateTimeFormat(locales, {
		timeZone,
		weekday: "short",
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(tsUtc * 1000));
}

/** A punch that is being edited, together with the typed values. */
interface EditState {
	/** The punch itself */
	entry: Entry;
	/** Local date of the punch */
	date: string;
	/** Local time, `HH:MM` */
	time: string;
	/** Direction */
	direction: "in" | "out";
	/** Note */
	note: string;
}

/** A day or a single punch that is being added. */
interface AddState {
	/** Local date, `YYYY-MM-DD` */
	date: string;
	/** Local time of the clock-in, `HH:MM` */
	from: string;
	/** Local time of the clock-out, empty when only one punch is added */
	to: string;
	/** Note */
	note: string;
}

/**
 * Shows the time corrections.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the corrections tab
 */
export function CorrectionsTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [userId, setUserId] = useState<number | null>(null);
	const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
	const [reason, setReason] = useState("");
	const [editing, setEditing] = useState<EditState | null>(null);
	const [adding, setAdding] = useState<AddState | null>(null);

	const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users(true) });
	const employee = userId ?? users.data?.[0]?.id ?? null;
	const [year, month] = period.split("-").map(Number);
	const range = monthRange(year, month);
	const timeZone = users.data?.find(entry => entry.id === employee)?.timezone ?? "Europe/Berlin";

	const entries = useQuery({
		queryKey: ["admin", "corrections", employee, range.from, range.to],
		queryFn: () => api.entries(range.from, range.to, employee ?? undefined),
		enabled: employee !== null,
	});

	/** Reloads the punches after a change. */
	const reload = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["admin", "corrections"] });
	};

	const change = useMutation({
		mutationFn: (input: {
			id: number;
			patch: { tsUtc?: number; direction?: "in" | "out"; note?: string | null };
		}) => api.updateEntry(input.id, { ...input.patch, reason: reason.trim() || null }),
		onSuccess: reload,
	});
	const remove = useMutation({
		mutationFn: (entry: Entry) => api.deleteEntry(entry.id, reason.trim() || null),
		onSuccess: reload,
	});
	const add = useMutation({
		mutationFn: async (input: AddState): Promise<void> => {
			if (employee === null) {
				return;
			}
			const note = input.note.trim() || null;
			const audit = reason.trim() || null;
			await api.createEntry({
				userId: employee,
				tsUtc: localToUtc(input.date, input.from, timeZone),
				direction: "in",
				note,
				reason: audit,
			});
			if (input.to.trim()) {
				await api.createEntry({
					userId: employee,
					tsUtc: localToUtc(input.date, input.to, timeZone),
					direction: "out",
					note,
					reason: audit,
				});
			}
		},
		onSuccess: reload,
	});

	if (users.isLoading) {
		return <Loading />;
	}

	/**
	 * Steps the shown month.
	 *
	 * @param direction - `-1` for the month before, `1` for the one after
	 */
	const step = (direction: number): void => {
		const next = new Date(Date.UTC(year, month - 1 + direction, 1));
		setPeriod(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`);
	};

	return (
		<>
			<ErrorAlert error={users.error ?? entries.error ?? change.error ?? remove.error ?? add.error} />

			<Card sx={{ p: 2, mb: 2 }}>
				<Stack
					direction={{ xs: "column", sm: "row" }}
					spacing={2}
					alignItems={{ xs: "stretch", sm: "center" }}
				>
					<TextField
						select
						size="small"
						label={t("corrections.employee")}
						value={employee ?? ""}
						onChange={event => setUserId(Number(event.target.value))}
						sx={{ minWidth: 200 }}
					>
						{(users.data ?? []).map(user => (
							<MenuItem
								key={user.id}
								value={user.id}
							>
								{user.displayName}
							</MenuItem>
						))}
					</TextField>

					<Stack
						direction="row"
						spacing={0.5}
						alignItems="center"
					>
						<IconButton
							onClick={() => step(-1)}
							title={t("corrections.previous")}
							aria-label={t("corrections.previous")}
						>
							<ChevronLeftIcon />
						</IconButton>
						<Typography sx={{ minWidth: 90, textAlign: "center" }}>{period}</Typography>
						<IconButton
							onClick={() => step(1)}
							title={t("corrections.next")}
							aria-label={t("corrections.next")}
						>
							<ChevronRightIcon />
						</IconButton>
					</Stack>

					<TextField
						size="small"
						label={t("corrections.reason")}
						helperText={t("corrections.reasonHint")}
						value={reason}
						onChange={event => setReason(event.target.value)}
						sx={{ flexGrow: 1, minWidth: 220 }}
					/>

					<Button
						variant="contained"
						disabled={employee === null}
						onClick={() => setAdding({ date: range.from, from: "08:00", to: "17:00", note: "" })}
					>
						{t("corrections.add")}
					</Button>
				</Stack>
			</Card>

			<Card>
				<List dense>
					{(entries.data ?? []).map(entry => (
						<ListItem
							key={entry.id}
							secondaryAction={
								<Stack
									direction="row"
									spacing={0.5}
								>
									<IconButton
										size="small"
										title={t("corrections.edit")}
										aria-label={t("corrections.edit")}
										onClick={() => {
											const localDate = entry.localDate;
											const time = formatTime(entry.tsUtc, timeZone, "de-DE");
											setEditing({
												entry,
												date: localDate,
												time,
												direction: entry.direction,
												note: entry.note ?? "",
											});
										}}
									>
										<EditIcon fontSize="small" />
									</IconButton>
									<IconButton
										size="small"
										title={t("corrections.remove")}
										aria-label={t("corrections.remove")}
										onClick={() => remove.mutate(entry)}
									>
										<DeleteIcon fontSize="small" />
									</IconButton>
								</Stack>
							}
						>
							<ListItemText
								primary={`${formatPunch(entry.tsUtc, timeZone, language)} · ${t(
									entry.direction === "in" ? "punch.in" : "punch.out",
								)}`}
								secondary={[
									// the source says where a punch came from; `admin` marks a correction
									entry.source === "admin" ? t("corrections.byAdmin") : entry.source,
									entry.note,
								]
									.filter(Boolean)
									.join(" · ")}
							/>
						</ListItem>
					))}
					{(entries.data ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("corrections.empty")} />
						</ListItem>
					)}
				</List>
			</Card>

			{editing && (
				<Dialog
					open
					onClose={() => setEditing(null)}
				>
					<DialogTitle>{t("corrections.editTitle")}</DialogTitle>
					<DialogContent>
						<Stack
							spacing={2}
							sx={{ mt: 1 }}
						>
							<TextField
								type="date"
								label={t("corrections.date")}
								value={editing.date}
								onChange={event => setEditing({ ...editing, date: event.target.value })}
								InputLabelProps={{ shrink: true }}
								fullWidth
							/>
							<TextField
								type="time"
								label={t(`corrections.${editing.direction === "in" ? "from" : "to"}`)}
								value={editing.time}
								onChange={event => setEditing({ ...editing, time: event.target.value })}
								InputLabelProps={{ shrink: true }}
								fullWidth
							/>
							<TextField
								select
								label={t("corrections.direction")}
								value={editing.direction}
								onChange={event =>
									setEditing({ ...editing, direction: event.target.value as "in" | "out" })
								}
							>
								<MenuItem value="in">{t("punch.in")}</MenuItem>
								<MenuItem value="out">{t("punch.out")}</MenuItem>
							</TextField>
							<TextField
								label={t("corrections.note")}
								value={editing.note}
								onChange={event => setEditing({ ...editing, note: event.target.value })}
								fullWidth
							/>
						</Stack>
					</DialogContent>
					<DialogActions>
						<Button onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
						<Button
							variant="contained"
							disabled={change.isPending}
							onClick={() => {
								change.mutate({
									id: editing.entry.id,
									patch: {
										tsUtc: localToUtc(editing.date, editing.time, timeZone),
										direction: editing.direction,
										note: editing.note.trim() || null,
									},
								});
								setEditing(null);
							}}
						>
							{t("common.save")}
						</Button>
					</DialogActions>
				</Dialog>
			)}

			{adding && (
				<Dialog
					open
					onClose={() => setAdding(null)}
				>
					<DialogTitle>{t("corrections.addTitle")}</DialogTitle>
					<DialogContent>
						<Stack
							spacing={2}
							sx={{ mt: 1 }}
						>
							<TextField
								type="date"
								label={t("corrections.date")}
								value={adding.date}
								onChange={event => setAdding({ ...adding, date: event.target.value })}
								InputLabelProps={{ shrink: true }}
								fullWidth
							/>
							<TextField
								type="time"
								label={t("corrections.from")}
								value={adding.from}
								onChange={event => setAdding({ ...adding, from: event.target.value })}
								InputLabelProps={{ shrink: true }}
								fullWidth
							/>
							<TextField
								type="time"
								label={t("corrections.to")}
								value={adding.to}
								onChange={event => setAdding({ ...adding, to: event.target.value })}
								helperText={t("corrections.addHint")}
								InputLabelProps={{ shrink: true }}
								fullWidth
							/>
							<TextField
								label={t("corrections.note")}
								value={adding.note}
								onChange={event => setAdding({ ...adding, note: event.target.value })}
								fullWidth
							/>
						</Stack>
					</DialogContent>
					<DialogActions>
						<Button onClick={() => setAdding(null)}>{t("common.cancel")}</Button>
						<Button
							variant="contained"
							disabled={add.isPending || adding.from.trim() === ""}
							onClick={() => {
								add.mutate(adding);
								setAdding(null);
							}}
						>
							{t("common.save")}
						</Button>
					</DialogActions>
				</Dialog>
			)}
		</>
	);
}
