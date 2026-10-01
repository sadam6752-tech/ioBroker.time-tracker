/**
 * Administration: AbsenceTypesCard (split out of `Admin.tsx`).
 */

import { type AbsenceType, api } from "../../api/client";
import { ActionRow } from "../../components/ActionRow";
import AddIcon from "@mui/icons-material/Add";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import DeleteIcon from "@mui/icons-material/Delete";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import EditIcon from "@mui/icons-material/Edit";
import { ErrorAlert } from "../../components/feedback";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Shows and changes the absence types: code, name, pay, factor and whether the type uses up the vacation.
 *
 * @param props - types, permission and the save callback
 * @param props.types - types as they are shown
 * @param props.disabled - true when the caller may not change types
 * @param props.onSaved - called after a type was stored
 * @returns the card with the list of types
 */
export function AbsenceTypesCard({
	types,
	disabled,
	onSaved,
}: {
	types: AbsenceType[];
	disabled: boolean;
	onSaved: () => void;
}): React.JSX.Element {
	const { t } = useTranslation();
	/** Copy the dialog works on; `null` while the dialog is closed. */
	const [draft, setDraft] = useState<AbsenceType | null>(null);
	/** True while the dialog shows a type that the server does not know yet. */
	const [isNew, setIsNew] = useState(false);
	/** The type the confirmation asks about, `null` while nothing is asked. */
	const [removing, setRemoving] = useState<AbsenceType | null>(null);
	const [error, setError] = useState<string | null>(null);

	const save = useMutation({
		mutationFn: (type: AbsenceType) =>
			api.saveAbsenceType({
				code: type.code.trim(),
				name: type.name.trim(),
				paid: type.paid,
				factor: type.factor,
				reduceVacation: type.reduceVacation,
				isActive: type.isActive,
				color: type.color ?? null,
			}),
		onSuccess: () => {
			setDraft(null);
			onSaved();
		},
		onError: (problem: Error) => setError(problem.message),
	});

	const remove = useMutation({
		mutationFn: (type: AbsenceType) => api.deleteAbsenceType(type.id),
		onSuccess: () => {
			setRemoving(null);
			onSaved();
		},
		onError: (problem: Error) => setError(problem.message),
	});

	/**
	 * Opens the dialog.
	 *
	 * @param type - the type to change; left out to add a new one
	 */
	const open = (type?: AbsenceType): void => {
		setError(null);
		setIsNew(type === undefined);
		setDraft(
			type
				? { ...type }
				: {
						id: 0,
						userId: null,
						code: "",
						name: "",
						paid: true,
						factor: 100,
						reduceVacation: false,
						isActive: true,
					},
		);
	};

	/**
	 * The facts of a type in one line.
	 *
	 * The visibility is not part of it: it has its own line in the row, so the long facts (`Zieht vom Urlaub ab`)
	 * cannot push it out of the line.
	 *
	 * @param type - the type
	 * @returns text like `Bezahlt · Faktor (%): 100 · Zieht vom Urlaub ab`
	 */
	const summary = (type: AbsenceType): string => {
		const parts = [
			type.paid ? t("admin.absenceTypes.paid") : `– ${t("admin.absenceTypes.paid")}`,
			`${t("admin.absenceTypes.factor")}: ${type.factor}`,
		];
		if (type.reduceVacation) {
			parts.push(t("admin.absenceTypes.reduceVacation"));
		}
		return parts.join(" · ");
	};

	/**
	 * The draft with a few fields replaced.
	 *
	 * @param type - the draft
	 * @param patch - fields to replace
	 * @returns a new draft
	 */
	const changed = (type: AbsenceType, patch: Partial<AbsenceType>): AbsenceType => ({ ...type, ...patch });

	return (
		<Card sx={{ mb: 2 }}>
			<CardContent>
				<Stack
					direction="row"
					spacing={1}
					sx={{ alignItems: "center" }}
				>
					<Typography
						variant="subtitle1"
						sx={{ flexGrow: 1 }}
					>
						{t("admin.absenceTypes.title")}
					</Typography>
					<Button
						size="small"
						startIcon={<AddIcon />}
						disabled={disabled}
						onClick={() => open()}
					>
						{t("admin.absenceTypes.add")}
					</Button>
				</Stack>
				<Typography
					variant="body2"
					color="text.secondary"
					sx={{ mb: 1 }}
				>
					{t("admin.absenceTypes.hint")}
				</Typography>

				<List
					dense
					data-testid="absence-types"
				>
					{types.map(type => (
						<ActionRow
							key={type.id}
							primary={`${type.code} – ${type.name}${
								type.reduceVacation ? ` (${t("absences.vacationTag")})` : ""
							}`}
							secondary={
								<>
									{summary(type)}
									{type.isActive && (
										// the visibility keeps a line of its own: the facts above must not push it out
										<Typography
											component="span"
											variant="caption"
											sx={{ display: "block" }}
										>
											{t("admin.absenceTypes.active")}
										</Typography>
									)}
								</>
							}
						>
							<span
								data-testid={`absence-type-color-${type.id}`}
								style={{
									width: 14,
									height: 14,
									borderRadius: "50%",
									marginRight: 6,
									display: "inline-block",
									background: type.color ?? "transparent",
									border: type.color ? "none" : "1px solid rgba(128,128,128,0.6)",
								}}
							/>
							<IconButton
								size="small"
								disabled={disabled}
								aria-label={t("admin.absenceTypes.edit")}
								onClick={() => open(type)}
							>
								<EditIcon fontSize="small" />
							</IconButton>
							<IconButton
								size="small"
								disabled={disabled}
								aria-label={t("admin.absenceTypes.remove")}
								data-testid={`absence-type-remove-${type.id}`}
								onClick={() => {
									setError(null);
									setRemoving(type);
								}}
							>
								<DeleteIcon fontSize="small" />
							</IconButton>
						</ActionRow>
					))}
				</List>
				{types.length === 0 && (
					<Typography
						variant="body2"
						color="text.secondary"
					>
						{t("admin.absenceTypes.empty")}
					</Typography>
				)}
				<Typography
					variant="caption"
					color="text.secondary"
				>
					{t("admin.absenceTypes.note")}
				</Typography>
			</CardContent>

			<Dialog
				open={draft !== null}
				onClose={() => setDraft(null)}
				fullWidth
				maxWidth="xs"
			>
				<DialogTitle>
					{isNew ? t("admin.absenceTypes.newTitle") : t("admin.absenceTypes.editTitle")}
				</DialogTitle>
				<DialogContent>
					{draft && (
						<Stack
							spacing={2}
							sx={{ mt: 1 }}
						>
							<ErrorAlert error={error} />
							<TextField
								label={t("admin.absenceTypes.code")}
								value={draft.code}
								size="small"
								inputProps={{ maxLength: 8 }}
								onChange={event => setDraft(changed(draft, { code: event.target.value }))}
							/>
							<TextField
								label={t("admin.absenceTypes.name")}
								value={draft.name}
								size="small"
								onChange={event => setDraft(changed(draft, { name: event.target.value }))}
							/>
							<TextField
								label={t("admin.absenceTypes.factor")}
								value={String(draft.factor)}
								size="small"
								type="number"
								inputProps={{ min: 0, max: 100, step: 10 }}
								onChange={event => setDraft(changed(draft, { factor: Number(event.target.value) }))}
							/>
							<FormControlLabel
								control={
									<Switch
										checked={draft.paid}
										onChange={event => setDraft(changed(draft, { paid: event.target.checked }))}
									/>
								}
								label={t("admin.absenceTypes.paid")}
							/>
							<FormControlLabel
								control={
									<Switch
										checked={draft.reduceVacation}
										onChange={event =>
											setDraft(changed(draft, { reduceVacation: event.target.checked }))
										}
									/>
								}
								label={t("admin.absenceTypes.reduceVacation")}
							/>
							<FormControlLabel
								control={
									<Switch
										checked={draft.isActive}
										onChange={event => setDraft(changed(draft, { isActive: event.target.checked }))}
									/>
								}
								label={t("admin.absenceTypes.active")}
							/>
							<Stack
								direction="row"
								spacing={1}
								sx={{ alignItems: "center" }}
							>
								<Typography
									variant="body2"
									sx={{ flexGrow: 1 }}
								>
									{t("admin.absenceTypes.color")}
								</Typography>
								<input
									type="color"
									data-testid="absence-type-color"
									value={draft.color ?? "#607d8b"}
									onChange={event => setDraft(changed(draft, { color: event.target.value }))}
								/>
								<Button
									size="small"
									data-testid="absence-type-color-clear"
									disabled={draft.color === null}
									onClick={() => setDraft(changed(draft, { color: null }))}
								>
									{t("admin.absenceTypes.colorClear")}
								</Button>
							</Stack>
						</Stack>
					)}
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDraft(null)}>{t("common.cancel")}</Button>
					<Button
						variant="contained"
						data-testid="absence-type-save"
						disabled={save.isPending || !draft || draft.code.trim() === "" || draft.name.trim() === ""}
						onClick={() => draft && save.mutate(draft)}
					>
						{t("common.save")}
					</Button>
				</DialogActions>
			</Dialog>

			<Dialog
				open={removing !== null}
				onClose={() => setRemoving(null)}
				fullWidth
				maxWidth="xs"
			>
				<DialogTitle>{t("admin.absenceTypes.removeTitle")}</DialogTitle>
				<DialogContent>
					<Stack
						spacing={2}
						sx={{ mt: 1 }}
					>
						<ErrorAlert error={error} />
						<DialogContentText>
							{removing
								? t("admin.absenceTypes.removeConfirm", { name: `${removing.code} – ${removing.name}` })
								: ""}
						</DialogContentText>
					</Stack>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
					<Button
						variant="contained"
						color="error"
						data-testid="absence-type-remove-save"
						disabled={remove.isPending}
						onClick={() => removing && remove.mutate(removing)}
					>
						{t("admin.absenceTypes.remove")}
					</Button>
				</DialogActions>
			</Dialog>
		</Card>
	);
}
