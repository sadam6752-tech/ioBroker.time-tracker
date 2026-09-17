import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import Button from "@mui/material/Button";
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

/**
 * Corrections of the punches of one day.
 *
 * The employee fixes what was forgotten — a missing punch or a wrong time — and only inside the edit window of the
 * instance: the API refuses older punches with `edit_window_closed`, and the dialog shows that message. Every row
 * is sent on its own, so one failure does not lose the other changes.
 *
 * @param props - day, time zone and close handler
 * @param props.day - day to correct, `null` closes the dialog
 * @param props.timeZone - time zone of the employee, used for the time fields
 * @param props.onClose - closes the dialog
 * @returns the dialog
 */
export function DayCorrectionsDialog({
	day,
	timeZone,
	onClose,
}: {
	day: DayAggregate | null;
	timeZone: string;
	onClose: () => void;
}): React.JSX.Element {
	const { t } = useTranslation();
	const { session, permissions } = useSession();
	const queryClient = useQueryClient();
	const date = day?.localDate ?? "";
	const punches = useQuery({
		queryKey: ["entries", date],
		queryFn: () => api.entries(date, date),
		enabled: day !== null,
	});
	/** Rows as they are edited; a row without `id` is a punch that is not stored yet. */
	const [rows, setRows] = useState<
		{ id?: number; revision?: number; time: string; direction: "in" | "out" }[] | null
	>(null);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const mayDelete = hasPermission(permissions, "time.delete");

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

	const shown =
		rows ??
		(punches.data ?? []).map(entry => ({
			id: entry.id,
			revision: entry.revision,
			time: timeOf(entry.tsUtc),
			direction: entry.direction ?? "in",
		}));

	/**
	 * Merges a change into one of the rows.
	 *
	 * @param index - position of the row
	 * @param patch - fields that changed
	 */
	const change = (index: number, patch: Partial<{ time: string; direction: "in" | "out" }>): void =>
		setRows(shown.map((row, position) => (position === index ? { ...row, ...patch } : row)));

	/** Saves the rows: changed times are patched, new rows are added. */
	const save = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		try {
			for (const row of shown) {
				const tsUtc = localToUtc(date, row.time, timeZone);
				const id = row.id;
				if (id === undefined) {
					await api.createEntry({ userId: session?.user.id ?? 0, tsUtc, direction: row.direction });
					continue;
				}
				const before = (punches.data ?? []).find(entry => entry.id === id);
				if (before && before.tsUtc !== tsUtc) {
					// the direction is only a hint for the screen: the order of the punches decides
					await api.updateEntry(id, { tsUtc, revision: before.revision });
				}
			}
			await queryClient.invalidateQueries({ queryKey: ["entries", date] });
			await queryClient.invalidateQueries({ queryKey: ["days"] });
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
			await queryClient.invalidateQueries({ queryKey: ["days"] });
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
			<DialogTitle>{t("month.editTitle", { date: date })}</DialogTitle>
			<DialogContent>
				<ErrorAlert error={error ?? punches.error} />
				<Typography
					variant="caption"
					color="text.secondary"
					display="block"
					sx={{ mb: 1 }}
				>
					{t("month.editHint")}
				</Typography>
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
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={busy || shown.length === 0}
					onClick={() => void save()}
				>
					{t("common.save")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}
