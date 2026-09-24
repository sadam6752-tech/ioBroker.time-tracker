/**
 * Corrections and the note of one day.
 *
 * The administration corrects the times of the day it opened (`time.edit_other`): it adds a forgotten punch, moves a
 * wrong one or removes it. An employee does not do that — he comments his day (“forgot to clock out”) and the
 * administration handles that note. Both modes live in this one dialog, because both are opened from the day row of
 * the month view. Every row is sent on its own, so one failure does not lose the other changes.
 */

import AddIcon from "@mui/icons-material/Add";
import CheckIcon from "@mui/icons-material/Check";
import DeleteIcon from "@mui/icons-material/Delete";
import ReplayIcon from "@mui/icons-material/Replay";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { DayAggregate } from "../api/types";
import { ErrorAlert } from "./feedback";
import { hasPermission, useSession } from "../state/session";
import { localToUtc } from "../screens/CorrectionsTab";

/** One row of the day as it is edited. */
interface CorrectionRow {
	/** Id of the stored punch, missing for a row that is not saved yet */
	id?: number;
	/** Revision the row was read with */
	revision?: number;
	/** Local wall clock time as `HH:MM` */
	time: string;
	/** Direction hint for the screen; the order of the punches decides */
	direction: "in" | "out";
}

/**
 * Shows the punches of one day and the note an employee left for it.
 *
 * @param props - day, owner, time zone and close handler
 * @param props.day - day to work on, `null` closes the dialog
 * @param props.userId - owner of the day when the administration looks at somebody else
 * @param props.timeZone - time zone of the owner, used for the time fields
 * @param props.onClose - closes the dialog
 * @returns the dialog
 */
export function DayCorrectionsDialog({
	day,
	userId,
	timeZone,
	onClose,
}: {
	day: DayAggregate | null;
	userId?: number;
	timeZone: string;
	onClose: () => void;
}): React.JSX.Element {
	const { t } = useTranslation();
	const { session, permissions } = useSession();
	const queryClient = useQueryClient();
	const date = day?.localDate ?? "";
	/** The administration changes the times; the employee only comments his day. */
	const mayCorrect = hasPermission(permissions, "time.edit_other");
	const mayDelete = hasPermission(permissions, "time.delete");
	const punches = useQuery({
		queryKey: ["entries", date, userId],
		queryFn: () => api.entries(date, date, userId),
		enabled: day !== null,
	});
	const notes = useQuery({
		queryKey: ["day-notes", date, userId],
		queryFn: () => api.dayNotes(date, date, userId),
		enabled: day !== null,
	});
	const stored = notes.data?.[0] ?? null;

	/** Rows as they are edited; `null` while the stored punches are shown. */
	const [rows, setRows] = useState<CorrectionRow[] | null>(null);
	/** Text the employee typed, `null` while the stored note is shown. */
	const [note, setNote] = useState<string | null>(null);
	/** Reason of a correction; it ends up in the audit trail */
	const [reason, setReason] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);

	/**
	 * Local wall clock time of a punch as `HH:MM`.
	 *
	 * @param tsUtc - punch instant
	 * @returns the time for a field
	 */
	const timeOf = (tsUtc: number): string =>
		new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(
			new Date(tsUtc * 1000),
		);

	const shown: CorrectionRow[] =
		rows ??
		(punches.data ?? []).map(entry => ({
			id: entry.id,
			revision: entry.revision,
			time: timeOf(entry.tsUtc),
			direction: entry.direction === "out" ? "out" : "in",
		}));

	/**
	 * Merges a change into one of the rows.
	 *
	 * @param index - position of the row
	 * @param patch - fields that changed
	 */
	const change = (index: number, patch: Partial<{ time: string; direction: "in" | "out" }>): void =>
		setRows(shown.map((row, position) => (position === index ? { ...row, ...patch } : row)));

	/** Tells every screen that the punches and the notes of this day changed. */
	const refresh = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["entries", date, userId] });
		await queryClient.invalidateQueries({ queryKey: ["day-notes"] });
		await queryClient.invalidateQueries({ queryKey: ["days"] });
		await queryClient.invalidateQueries({ queryKey: ["status"] });
	};

	/** Saves the rows of the administration: changed times are patched, new rows are added. */
	const save = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			for (const row of shown) {
				const tsUtc = localToUtc(date, row.time, timeZone);
				if (row.id === undefined) {
					await api.createEntry({
						userId: userId ?? session?.user.id ?? 0,
						tsUtc,
						direction: row.direction,
						...(reason.trim() ? { reason: reason.trim() } : {}),
					});
					continue;
				}
				const before = (punches.data ?? []).find(entry => entry.id === row.id);
				if (before && before.tsUtc !== tsUtc) {
					await api.updateEntry(row.id, {
						tsUtc,
						revision: before.revision,
						...(reason.trim() ? { reason: reason.trim() } : {}),
					});
				}
			}
			await refresh();
			onClose();
		} catch (caught) {
			setError(caught);
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Removes a punch of the day.
	 *
	 * @param row - row to remove
	 * @param row.id - id of the stored punch, missing for a row that was never saved
	 */
	const remove = async (row: { id?: number }): Promise<void> => {
		if (row.id === undefined) {
			// a row that was never saved: just drop it
			setRows(shown.filter(entry => entry !== row));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.deleteEntry(row.id, null);
			setRows(null);
			await punches.refetch();
			await refresh();
		} catch (caught) {
			setError(caught);
		} finally {
			setBusy(false);
		}
	};

	/** Writes the note of the day; an empty text takes it back. */
	const saveNote = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await api.saveDayNote({
				date,
				note: note ?? stored?.note ?? "",
				...(userId !== undefined ? { userId } : {}),
			});
			setNote(null);
			await refresh();
			onClose();
		} catch (caught) {
			setError(caught);
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Marks the note of the day as handled or open again.
	 *
	 * @param handled - the state the note gets
	 */
	const handleNote = async (handled: boolean): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			await api.setDayNoteHandled({ date, handled, ...(userId !== undefined ? { userId } : {}) });
			await refresh();
		} catch (caught) {
			setError(caught);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={day !== null}
			onClose={onClose}
			fullWidth
			maxWidth="xs"
		>
			<DialogTitle>{mayCorrect ? t("month.editTitle", { date }) : t("month.noteTitle", { date })}</DialogTitle>
			<DialogContent>
				<ErrorAlert error={error ?? punches.error ?? notes.error} />
				<Typography
					variant="caption"
					color="text.secondary"
					display="block"
					sx={{ mb: 1 }}
				>
					{mayCorrect ? t("month.editHint") : t("month.noteHint")}
				</Typography>

				{/* what the employee wrote for this day: the administration reads it and marks it as handled */}
				{stored && (
					<Stack
						spacing={0.5}
						sx={{ mb: 2 }}
					>
						<Stack
							direction="row"
							spacing={1}
							sx={{ alignItems: "center" }}
						>
							<Typography
								variant="subtitle2"
								sx={{ flexGrow: 1 }}
							>
								{t("month.noteLabel")}
							</Typography>
							<Chip
								size="small"
								color={stored.handledAt === null ? "warning" : "success"}
								label={stored.handledAt === null ? t("month.noteOpen") : t("month.noteHandled")}
							/>
						</Stack>
						<Typography variant="body2">{stored.note}</Typography>
						{mayCorrect && (
							<Button
								size="small"
								variant="outlined"
								startIcon={stored.handledAt === null ? <CheckIcon /> : <ReplayIcon />}
								disabled={busy}
								onClick={() => void handleNote(stored.handledAt === null)}
							>
								{stored.handledAt === null ? t("month.markHandled") : t("month.reopenNote")}
							</Button>
						)}
					</Stack>
				)}

				{mayCorrect ? (
					<Stack spacing={1}>
						{shown.map((row, index) => (
							<Stack
								key={row.id ?? `new-${index}`}
								direction="row"
								spacing={1}
								useFlexGap
								sx={{ alignItems: "center", flexWrap: "wrap" }}
							>
								<TextField
									size="small"
									type="time"
									label={t("month.time")}
									value={row.time}
									onChange={event => change(index, { time: event.target.value })}
								/>
								<TextField
									size="small"
									select
									label={t("month.direction")}
									value={row.direction}
									onChange={event => change(index, { direction: event.target.value as "in" | "out" })}
								>
									<MenuItem value="in">{t("month.directionIn")}</MenuItem>
									<MenuItem value="out">{t("month.directionOut")}</MenuItem>
								</TextField>
								{mayDelete && (
									<IconButton
										size="small"
										title={t("admin.backup.delete")}
										disabled={busy}
										onClick={() => void remove(row)}
									>
										<DeleteIcon fontSize="small" />
									</IconButton>
								)}
							</Stack>
						))}
						<Button
							size="small"
							startIcon={<AddIcon />}
							disabled={busy}
							onClick={() =>
								setRows([...shown, { time: "12:00", direction: shown.length % 2 === 0 ? "in" : "out" }])
							}
						>
							{t("month.addPunch")}
						</Button>
						<TextField
							label={t("corrections.reason")}
							helperText={t("corrections.reasonHint")}
							value={reason}
							size="small"
							onChange={event => setReason(event.target.value)}
						/>
					</Stack>
				) : (
					<Stack spacing={1}>
						<Typography variant="subtitle2">{t("month.punches")}</Typography>
						{shown.length === 0 ? (
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("month.noPunches")}
							</Typography>
						) : (
							shown.map((row, index) => (
								<Typography
									key={row.id ?? `row-${index}`}
									variant="body2"
								>
									{row.time} ·{" "}
									{row.direction === "out" ? t("month.directionOut") : t("month.directionIn")}
								</Typography>
							))
						)}
						<TextField
							label={t("month.noteLabel")}
							value={note ?? stored?.note ?? ""}
							size="small"
							multiline
							minRows={2}
							onChange={event => setNote(event.target.value)}
						/>
					</Stack>
				)}
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={busy || (mayCorrect && shown.length === 0)}
					onClick={() => void (mayCorrect ? save() : saveNote())}
				>
					{t("common.save")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}
