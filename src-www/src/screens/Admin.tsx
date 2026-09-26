/**
 * Administration: employees and database backups.
 *
 * The screen only offers what the caller is allowed to do — the server checks the permissions again, the UI
 * just avoids showing buttons that would fail. It is reachable from the menu, not from the bottom navigation,
 * because most users never need it.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import { BRAND_PRESET_COLORS } from "../state/branding";
import { AVATAR_MAX_BYTES, BRANDING_MAX_BYTES, prepareImage, type ImageProblem } from "../components/image-file";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { CorrectionsTab } from "./CorrectionsTab";
import { AbsencesTab } from "./AbsencesTab";
import BackupIcon from "@mui/icons-material/Backup";
import DownloadIcon from "@mui/icons-material/Download";
import RestoreIcon from "@mui/icons-material/Restore";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import KeyIcon from "@mui/icons-material/Key";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import TerminalIcon from "@mui/icons-material/Terminal";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	api,
	formatDate,
	type AbsenceType,
	type AdminTerminal,
	type AutomationRule,
	type AutomationRun,
	type RfidTagRecord,
	type TriggerRule,
} from "../api/client";
import type { AdminUser, CreateUserInput, PauseRule, WorkProfile } from "../api/types";
import { AppShell } from "../components/AppShell";
import { ActionRow } from "../components/ActionRow";
import { ErrorAlert, Loading } from "../components/feedback";
import { saveBlob } from "../components/ReportDownloads";
import { hasPermission, useSession } from "../state/session";

/**
 * Short weekday names of the display language.
 *
 * The names come from `Intl`, so a translation of “Mo”, “Tue”, … is not needed and every language gets its own
 * spelling. The 1st of January 2024 was a Monday, so the year starts exactly with the day the mask starts with.
 *
 * @param language - language of the display
 * @returns the seven days, ISO numbered 1..7
 */
function weekdayOptions(language: string): { value: number; label: string }[] {
	const format = new Intl.DateTimeFormat(language, { weekday: "short" });
	return [1, 2, 3, 4, 5, 6, 7].map(value => ({
		value,
		label: format.format(new Date(Date.UTC(2024, 0, value))),
	}));
}

/**
 * Turns one weekday of a rule on or off.
 *
 * @param weekdays - current selection
 * @param day - ISO weekday to change
 * @param checked - new state
 * @returns the new selection, sorted
 */
function toggleWeekday(weekdays: number[], day: number, checked: boolean): number[] {
	const next = checked ? [...weekdays, day] : weekdays.filter(value => value !== day);
	return [...new Set(next)].sort((left, right) => left - right);
}

/**
 * Formats a byte count for the backup list.
 *
 * @param bytes - size in bytes
 * @param language - language of the display
 * @returns formatted size, e.g. `201 kB`
 */
function formatSize(bytes: number, language: string): string {
	return new Intl.NumberFormat(language, { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 }).format(
		Math.max(1, Math.round(bytes / 1024)),
	);
}

/**
 * Dialog that creates an employee.
 *
 * @param props - language, close handler and success handler
 * @param props.language - language of the display
 * @param props.onClose - called when the dialog is closed
 * @param props.onCreated - called after the employee was created
 * @returns the dialog
 */
function CreateUserDialog({
	onClose,
	onCreated,
}: {
	language: string;
	onClose: () => void;
	onCreated: () => Promise<void>;
}): React.JSX.Element {
	const { t } = useTranslation();
	const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: () => api.roles() });
	const [form, setForm] = useState<CreateUserInput>({
		login: "",
		displayName: "",
		password: "",
		roleKeys: ["employee"],
	});

	const create = useMutation({
		mutationFn: (input: CreateUserInput) => api.createUser(input),
		onSuccess: onCreated,
	});

	const field = (
		key: keyof CreateUserInput,
	): { value: string; onChange: (event: React.ChangeEvent<HTMLInputElement>) => void } => ({
		value: String(form[key]),
		onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
			setForm(current => ({ ...current, [key]: event.target.value })),
	});

	return (
		<Dialog
			open
			onClose={onClose}
			fullWidth
		>
			<DialogTitle>{t("admin.user.create")}</DialogTitle>
			<DialogContent>
				<ErrorAlert error={create.error ?? roles.error} />
				<Stack sx={{ mt: 1 }}>
					<TextField
						autoFocus
						fullWidth
						label={t("admin.user.login")}
						{...field("login")}
					/>
					<TextField
						fullWidth
						label={t("admin.user.name")}
						sx={{ mt: 2 }}
						{...field("displayName")}
					/>
					<TextField
						fullWidth
						type="password"
						label={t("admin.user.password")}
						helperText={t("admin.user.passwordHint")}
						sx={{ mt: 2 }}
						{...field("password")}
					/>
					<TextField
						select
						fullWidth
						label={t("admin.user.roles")}
						sx={{ mt: 2 }}
						value={form.roleKeys[0] ?? "employee"}
						onChange={event => setForm(current => ({ ...current, roleKeys: [event.target.value] }))}
					>
						{(roles.data ?? []).map(role => (
							<MenuItem
								key={role.key}
								value={role.key}
							>
								{t(`role.${role.key}`, role.name)}
							</MenuItem>
						))}
					</TextField>
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={
						create.isPending ||
						form.login.trim() === "" ||
						form.displayName.trim() === "" ||
						form.password.length < 8
					}
					onClick={() => create.mutate(form)}
				>
					{t("common.save")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}

/**
 * Formats an instant of a backup.
 *
 * @param tsUtc - UTC epoch seconds
 * @param language - language of the display
 * @returns formatted date and time
 */
function formatStamp(tsUtc: number, language: string): string {
	return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(tsUtc * 1000));
}

/**
 * Employees: list, create, activate/deactivate, badge PIN.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the users tab
 */
/**
 * Editor of a table of graduated break rules.
 *
 * The same table is used for the company default (settings) and for the rules of a single employee (work profile);
 * the caller owns the state and saves the whole table, because the API replaces it.
 *
 * @param props - rules, permission and handlers
 * @param props.rules - rules as they are shown
 * @param props.disabled - true when the caller may not change them
 * @param props.saving - true while a save is running
 * @param props.onChange - called with the changed table
 * @param props.onSave - saves the table
 * @returns the editor
 */
function PauseRuleTable({
	rules,
	disabled,
	saving,
	onChange,
	onSave,
}: {
	rules: PauseRule[];
	disabled: boolean;
	saving: boolean;
	onChange: (rules: PauseRule[]) => void;
	onSave: () => void;
}): React.JSX.Element {
	const { t } = useTranslation();

	/**
	 * Merges a change into one of the rules.
	 *
	 * @param index - position of the rule in the list
	 * @param patch - fields that changed
	 */
	const change = (index: number, patch: Partial<PauseRule>): void =>
		onChange(rules.map((rule, position) => (position === index ? { ...rule, ...patch } : rule)));

	return (
		<Stack spacing={1}>
			{rules.map((rule, index) => (
				<Stack
					key={rule.id ?? `new-${index}`}
					direction="row"
					spacing={1}
					useFlexGap
					sx={{ alignItems: "center", flexWrap: "wrap" }}
				>
					<TextField
						size="small"
						type="number"
						label={t("admin.settings.pauseFrom")}
						value={String(rule.fromMin)}
						onChange={event => change(index, { fromMin: Number(event.target.value) })}
						disabled={disabled}
					/>
					<TextField
						size="small"
						type="number"
						label={t("admin.settings.pauseTo")}
						value={rule.toMin === null ? "" : String(rule.toMin)}
						onChange={event =>
							change(index, { toMin: event.target.value === "" ? null : Number(event.target.value) })
						}
						disabled={disabled}
					/>
					<TextField
						size="small"
						type="number"
						label={t("admin.settings.pauseMinutes")}
						value={String(rule.pauseMin)}
						onChange={event => change(index, { pauseMin: Number(event.target.value) })}
						disabled={disabled}
					/>
					<Switch
						checked={rule.isActive !== false}
						title={t("admin.settings.pauseActive")}
						onChange={() => change(index, { isActive: rule.isActive === false })}
						disabled={disabled}
					/>
					<IconButton
						size="small"
						title={t("admin.backup.delete")}
						disabled={disabled}
						onClick={() => onChange(rules.filter((_, position) => position !== index))}
					>
						<DeleteIcon fontSize="small" />
					</IconButton>
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
					disabled={disabled}
					onClick={() => onChange([...rules, { fromMin: 360, toMin: null, pauseMin: 30, isActive: true }])}
				>
					{t("admin.settings.pauseAdd")}
				</Button>
				<Button
					size="small"
					variant="contained"
					disabled={disabled || saving}
					onClick={onSave}
				>
					{t("admin.settings.pauseSave")}
				</Button>
			</Stack>
		</Stack>
	);
}

/**
 * Work profile of one employee.
 *
 * The profile decides the target time of every day, how overtime is carried and whether a break is paid, so it
 * belongs to the administration. Only the changed fields are sent — the server merges them into the stored
 * profile and notes the change in the audit trail.
 *
 * @param props - employee and close handler
 * @param props.user - employee whose profile is edited, `null` closes the dialog
 * @param props.onClose - closes the dialog
 * @returns the dialog
 */
function WorkProfileDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const queryClient = useQueryClient();
	const id = user?.id ?? 0;
	const profile = useQuery({
		queryKey: ["admin", "profile", id],
		queryFn: () => api.workProfile(id),
		enabled: user !== null,
	});
	const [draft, setDraft] = useState<Partial<WorkProfile>>({});

	const save = useMutation({
		mutationFn: (patch: Partial<WorkProfile>) => api.saveWorkProfile(id, patch),
		onSuccess: async () => {
			setDraft({});
			await queryClient.invalidateQueries({ queryKey: ["admin", "profile", id] });
			onClose();
		},
	});
	// the break rules of this employee: they replace the company rule with the same `fromMin`
	const ownRules = useQuery({
		queryKey: ["admin", "pauseRules", id],
		queryFn: () => api.userPauseRules(id),
		enabled: user !== null,
	});
	const [rules, setRules] = useState<PauseRule[] | null>(null);
	const shownRules = rules ?? ownRules.data ?? [];
	const saveRules = useMutation({
		mutationFn: (list: PauseRule[]) => api.saveUserPauseRules(id, list),
		onSuccess: async () => {
			setRules(null);
			await queryClient.invalidateQueries({ queryKey: ["admin", "pauseRules", id] });
			onClose();
		},
	});

	/**
	 * Merges a change into the pending patch.
	 *
	 * @param patch - fields that changed
	 */
	const set = (patch: Partial<WorkProfile>): void => setDraft(previous => ({ ...previous, ...patch }));
	// the stored profile with the pending changes on top: what the fields show
	const current = profile.data ? { ...profile.data, ...draft } : null;
	// the profile stores minutes, the dialog shows hours
	const minutesToHours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

	// 2026-01-04 is a Sunday, so the seven names line up with the `workdays` field (index 0 = Sunday)
	const weekdayNames = Array.from({ length: 7 }, (_, index) =>
		new Intl.DateTimeFormat(i18n.language, { weekday: "narrow" }).format(new Date(Date.UTC(2026, 0, 4 + index))),
	);
	const workdays = (current?.workdays ?? "0;1;1;1;1;1;0").split(";");

	/**
	 * Renders a whole number field of the profile.
	 *
	 * @param key - field of the profile
	 * @param label - label of the field
	 * @param step - step of the input (fractions for hours and days)
	 * @returns the field
	 */
	const numberField = (
		key: "percent" | "weeklyHours" | "vacationPerYear" | "vacationCarryover" | "pausePaidMinutes",
		label: string,
		step?: string,
	): React.JSX.Element => (
		<TextField
			fullWidth
			size="small"
			type="number"
			label={label}
			value={String(current?.[key] ?? 0)}
			onChange={event => set({ [key]: Number(event.target.value) })}
			inputProps={step ? { step } : undefined}
		/>
	);

	return (
		<Dialog
			open={user !== null}
			onClose={onClose}
			fullWidth
			maxWidth="sm"
		>
			<DialogTitle>{t("admin.user.profileTitle", { name: user?.displayName ?? "" })}</DialogTitle>
			<DialogContent>
				<ErrorAlert error={profile.error ?? save.error ?? ownRules.error ?? saveRules.error} />
				{profile.isLoading ? (
					<Loading />
				) : (
					<Stack
						spacing={2}
						sx={{ mt: 1 }}
					>
						<Stack
							direction="row"
							spacing={2}
						>
							{numberField("percent", t("admin.profile.percent"))}
							{numberField("weeklyHours", t("admin.profile.weeklyHours"), "0.5")}
						</Stack>
						<Box>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("admin.profile.workdays")}
							</Typography>
							<Stack
								direction="row"
								spacing={1}
								sx={{ alignItems: "center", flexWrap: "wrap" }}
							>
								{weekdayNames.map((name, index) => (
									<Stack
										key={`${name}-${index}`}
										direction="row"
										sx={{ alignItems: "center" }}
									>
										<Checkbox
											size="small"
											checked={workdays[index] === "1"}
											onChange={() => {
												const next = workdays.slice();
												next[index] = next[index] === "1" ? "0" : "1";
												set({ workdays: next.join(";") });
											}}
										/>
										<Typography variant="body2">{name}</Typography>
									</Stack>
								))}
							</Stack>
						</Box>
						<TextField
							select
							fullWidth
							size="small"
							label={t("admin.profile.overtimeModel")}
							value={current?.overtimeModel ?? "monthly"}
							onChange={event =>
								set({ overtimeModel: event.target.value as WorkProfile["overtimeModel"] })
							}
						>
							{(["monthly", "yearly", "cumulative"] as const).map(model => (
								<MenuItem
									key={model}
									value={model}
								>
									{t(`admin.profile.model.${model}`)}
								</MenuItem>
							))}
						</TextField>
						<Box>
							<FormControlLabel
								control={
									<Switch
										checked={current?.showWorkedTime === true}
										onChange={event => set({ showWorkedTime: event.target.checked })}
									/>
								}
								label={t("admin.user.workedTime")}
							/>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("admin.user.workedTimeHint")}
							</Typography>
						</Box>
						<Stack
							direction="row"
							spacing={2}
						>
							{numberField("vacationPerYear", t("admin.profile.vacationPerYear"), "0.5")}
							{numberField("vacationCarryover", t("admin.profile.vacationCarryover"), "0.5")}
						</Stack>
						<Stack
							direction="row"
							spacing={2}
						>
							<TextField
								fullWidth
								size="small"
								type="number"
								label={t("admin.profile.overtimeCarryover")}
								value={String(minutesToHours(current?.overtimeCarryover ?? 0))}
								onChange={event =>
									set({ overtimeCarryover: Math.round(Number(event.target.value) * 60) })
								}
							/>
							<TextField
								fullWidth
								size="small"
								type="number"
								label={t("admin.profile.vorholzeitPerYear")}
								value={String(minutesToHours(current?.vorholzeitPerYear ?? 0))}
								onChange={event =>
									set({ vorholzeitPerYear: Math.round(Number(event.target.value) * 60) })
								}
							/>
						</Stack>
						<TextField
							fullWidth
							size="small"
							type="number"
							label={t("admin.profile.pausePaid")}
							helperText={t("admin.profile.pausePaidHint")}
							value={String(current?.pausePaidMinutes ?? 0)}
							onChange={event =>
								set({ pausePaidMinutes: Math.max(0, Math.round(Number(event.target.value))) })
							}
						/>
						<Box>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("admin.profile.pauseRules")}
							</Typography>
							<Typography
								variant="caption"
								color="text.secondary"
								display="block"
								sx={{ mb: 1 }}
							>
								{t("admin.profile.pauseRulesHint")}
							</Typography>
							<PauseRuleTable
								rules={shownRules}
								disabled={false}
								saving={saveRules.isPending}
								onChange={setRules}
								onSave={() => saveRules.mutate(shownRules)}
							/>
						</Box>
					</Stack>
				)}
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={save.isPending || Object.keys(draft).length === 0}
					onClick={() => save.mutate(draft)}
				>
					{t("common.save")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}

function UsersTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const { session, permissions } = useSession();
	const queryClient = useQueryClient();
	const mayEdit = hasPermission(permissions, "user.edit");
	const mayCreate = hasPermission(permissions, "user.create");
	const [creating, setCreating] = useState(false);
	const [pinUser, setPinUser] = useState<AdminUser | null>(null);
	const [pin, setPin] = useState("");
	const [photoUser, setPhotoUser] = useState<AdminUser | null>(null);
	const [photo, setPhoto] = useState<string | null>(null);
	const [rolesUser, setRolesUser] = useState<AdminUser | null>(null);
	const [profileUser, setProfileUser] = useState<AdminUser | null>(null);
	/** True while the hint about the own account is on screen. */
	const [warnSelf, setWarnSelf] = useState(false);
	// assigning roles is a right of its own (the server checks it again)
	const mayManageRoles = hasPermission(permissions, "user.manage_roles");
	/** Account of the caller: it cannot be deactivated itself, and its admin role is the last one to keep. */
	const ownId = session?.user.id ?? 0;

	const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users(true) });
	/** Active administrators: the last one keeps its activity and its role (the server refuses that change too). */
	const activeAdmins = (users.data ?? []).filter(user => user.isActive && user.roles.includes("admin"));

	/** Reloads the list after a change. */
	const reload = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
	};

	const change = useMutation({
		mutationFn: ({ id, patch }: { id: number; patch: { isActive?: boolean; roleKeys?: string[] } }) =>
			api.updateUser(id, patch),
		onSuccess: reload,
	});
	const savePin = useMutation({
		mutationFn: ({ id, value }: { id: number; value: string }) => api.setPin(id, value),
		onSuccess: async () => {
			setPinUser(null);
			setPin("");
			await reload();
		},
	});
	const savePhoto = useMutation({
		mutationFn: ({ id, value }: { id: number; value: string | null }) => api.updateUser(id, { avatar: value }),
		onSuccess: async () => {
			setPhotoUser(null);
			setPhoto(null);
			await reload();
		},
	});

	if (users.isLoading) {
		return <Loading />;
	}

	return (
		<>
			<ErrorAlert error={users.error ?? change.error ?? savePin.error ?? savePhoto.error} />

			{mayCreate && (
				<Box sx={{ mb: 2 }}>
					<Button
						variant="contained"
						startIcon={<PersonAddIcon />}
						onClick={() => setCreating(true)}
					>
						{t("admin.user.create")}
					</Button>
				</Box>
			)}

			<Card>
				<List dense>
					{(users.data ?? []).map(user => (
						<ActionRow
							key={user.id}
							primary={`${user.displayName} (${user.login})`}
							secondary={
								<Stack
									direction="row"
									spacing={0.5}
									sx={{ mt: 0.5 }}
								>
									{user.roles.map(role => (
										<Chip
											key={role}
											size="small"
											label={t(`role.${role}`, role)}
										/>
									))}
									{!user.isActive && (
										<Chip
											size="small"
											color="default"
											label={t("admin.user.inactive")}
										/>
									)}
								</Stack>
							}
						>
							{mayEdit && (
								<>
									<Button
										size="small"
										startIcon={<KeyIcon />}
										onClick={() => {
											setPinUser(user);
											setPin("");
										}}
									>
										{t("admin.user.pin")}
									</Button>
									<Button
										size="small"
										onClick={() => {
											setPhotoUser(user);
											setPhoto(null);
										}}
									>
										{t("admin.user.photo")}
									</Button>
									{/* the work profile decides the target time of every day and how a break is treated */}
									<Button
										size="small"
										onClick={() => setProfileUser(user)}
									>
										{t("admin.user.profile")}
									</Button>
									{mayManageRoles && (
										<Button
											size="small"
											onClick={() => setRolesUser(user)}
										>
											{t("admin.user.roles")}
										</Button>
									)}
									<Switch
										checked={user.isActive}
										title={t(user.isActive ? "admin.user.active" : "admin.user.inactive")}
										onChange={() => {
											if (user.id === ownId && user.isActive) {
												// the own account cannot be deactivated (the server refuses it) — explain it
												setWarnSelf(true);
												return;
											}
											change.mutate({ id: user.id, patch: { isActive: !user.isActive } });
										}}
									/>
								</>
							)}
						</ActionRow>
					))}
					{(users.data ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("admin.user.empty")} />
						</ListItem>
					)}
				</List>
			</Card>

			<WorkProfileDialog
				user={profileUser}
				onClose={() => setProfileUser(null)}
			/>

			<Dialog
				open={pinUser !== null}
				onClose={() => setPinUser(null)}
			>
				<DialogTitle>{t("admin.user.pinTitle", { name: pinUser?.displayName ?? "" })}</DialogTitle>
				<DialogContent>
					<TextField
						autoFocus
						fullWidth
						inputMode="numeric"
						label={t("admin.user.newPin")}
						helperText={t("admin.user.pinHint")}
						value={pin}
						onChange={event => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
						sx={{ mt: 1 }}
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setPinUser(null)}>{t("common.cancel")}</Button>
					<Button
						variant="contained"
						disabled={pin.length < 4 || savePin.isPending}
						onClick={() => pinUser && savePin.mutate({ id: pinUser.id, value: pin })}
					>
						{t("common.save")}
					</Button>
				</DialogActions>
			</Dialog>

			<Dialog
				open={photoUser !== null}
				onClose={() => setPhotoUser(null)}
			>
				<DialogTitle>{t("admin.user.photoTitle", { name: photoUser?.displayName ?? "" })}</DialogTitle>
				<DialogContent>
					<Stack
						spacing={2}
						sx={{ mt: 1 }}
					>
						<img
							// what is stored now — the placeholder until a picture of this employee is chosen
							src={photo ?? photoUser?.avatarUrl ?? "/person.png"}
							alt=""
							width={96}
							height={96}
							style={{ objectFit: "cover", borderRadius: 8 }}
						/>
						<PictureField
							label={t("admin.user.photoChoose")}
							maxBytes={AVATAR_MAX_BYTES}
							hint={t("admin.user.photoHint")}
							onChange={value => setPhoto(value)}
						/>
					</Stack>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setPhotoUser(null)}>{t("common.cancel")}</Button>
					<Button
						disabled={photoUser?.avatarUrl === null || photoUser?.avatarUrl === undefined}
						onClick={() => photoUser && savePhoto.mutate({ id: photoUser.id, value: null })}
					>
						{t("admin.user.photoRemove")}
					</Button>
					<Button
						variant="contained"
						disabled={photo === null || savePhoto.isPending}
						onClick={() => photoUser && savePhoto.mutate({ id: photoUser.id, value: photo })}
					>
						{t("common.save")}
					</Button>
				</DialogActions>
			</Dialog>

			{rolesUser && (
				<RolesDialog
					user={rolesUser}
					isSelf={rolesUser.id === ownId}
					lastAdministrator={activeAdmins.length === 1 && rolesUser.roles.includes("admin")}
					onClose={() => setRolesUser(null)}
					onSaved={roleKeys => {
						change.mutate({ id: rolesUser.id, patch: { roleKeys } });
						setRolesUser(null);
					}}
				/>
			)}

			<Dialog
				open={warnSelf}
				onClose={() => setWarnSelf(false)}
			>
				<DialogTitle>{t("admin.user.selfTitle")}</DialogTitle>
				<DialogContent>
					<DialogContentText>{t("admin.user.selfDeactivate")}</DialogContentText>
				</DialogContent>
				<DialogActions>
					<Button
						variant="contained"
						onClick={() => setWarnSelf(false)}
					>
						{t("common.close")}
					</Button>
				</DialogActions>
			</Dialog>

			{creating && (
				<CreateUserDialog
					language={language}
					onClose={() => setCreating(false)}
					onCreated={async () => {
						setCreating(false);
						await reload();
					}}
				/>
			)}
		</>
	);
}

/**
 * Dialog that creates a kiosk terminal and hands the device token back once.
 *
 * @param props - close handler and success handler
 * @param props.onClose - called when the dialog is closed
 * @param props.onCreated - called with the created terminal and its device token
 * @returns the dialog
 */
function CreateTerminalDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (issued: { terminal: AdminTerminal; deviceToken: string }) => Promise<void>;
}): React.JSX.Element {
	const { t } = useTranslation();
	const employees = useQuery({ queryKey: ["admin", "users", "active"], queryFn: () => api.users(false) });
	const [name, setName] = useState("");
	const [location, setLocation] = useState("");
	const [pinRequired, setPinRequired] = useState(true);
	const [chosen, setChosen] = useState<number[]>([]);

	const create = useMutation({
		mutationFn: () =>
			api.createTerminal({
				name: name.trim(),
				...(location.trim() ? { location: location.trim() } : {}),
				pinRequired,
				// no selection means “all employees”, which is how terminals worked before
				userIds: chosen,
			}),
		onSuccess: onCreated,
	});

	return (
		<Dialog
			open
			onClose={onClose}
			fullWidth
		>
			<DialogTitle>{t("admin.terminal.create")}</DialogTitle>
			<DialogContent>
				<Stack
					spacing={2}
					sx={{ mt: 1 }}
				>
					<TextField
						label={t("admin.terminal.name")}
						value={name}
						onChange={event => setName(event.target.value)}
						fullWidth
						autoFocus
					/>
					<TextField
						label={t("admin.terminal.location")}
						value={location}
						onChange={event => setLocation(event.target.value)}
						fullWidth
					/>
					<Stack
						direction="row"
						spacing={1}
						alignItems="center"
					>
						<Switch
							checked={pinRequired}
							onChange={(_event, checked) => setPinRequired(checked)}
						/>
						<Typography>{t("admin.terminal.pinRequired")}</Typography>
					</Stack>
					<Typography variant="subtitle2">{t("admin.terminal.users")}</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
					>
						{t("admin.terminal.usersHint")}
					</Typography>
					<EmployeePicker
						users={employees.data ?? []}
						chosen={chosen}
						onChange={setChosen}
					/>
					<ErrorAlert error={create.error} />
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={name.trim().length === 0 || create.isPending}
					onClick={() => create.mutate()}
				>
					{t("admin.terminal.create")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}

/**
 * Picks the employees of a terminal.
 *
 * @param props - employees, current selection and handler
 * @param props.users - employees to choose from
 * @param props.chosen - selected ids (an empty list means “all employees”)
 * @param props.onChange - called with the new selection
 * @returns the list of switches
 */
function EmployeePicker({
	users,
	chosen,
	onChange,
}: {
	users: AdminUser[];
	chosen: number[];
	onChange: (ids: number[]) => void;
}): React.JSX.Element {
	return (
		<Box sx={{ maxHeight: 240, overflowY: "auto" }}>
			<Stack spacing={0.5}>
				{users.map(user => (
					<Stack
						key={user.id}
						direction="row"
						spacing={1}
						sx={{ alignItems: "center" }}
					>
						<Switch
							checked={chosen.includes(user.id)}
							inputProps={{ "aria-label": user.displayName }}
							onChange={(_event, checked) =>
								onChange(
									checked ? [...new Set([...chosen, user.id])] : chosen.filter(id => id !== user.id),
								)
							}
						/>
						<Typography>{user.displayName}</Typography>
					</Stack>
				))}
			</Stack>
		</Box>
	);
}

/**
 * Dialog that assigns the employees of a terminal.
 *
 * @param props - terminal, close handler and save handler
 * @param props.terminal - terminal to edit
 * @param props.onClose - called when the dialog is closed
 * @param props.onSaved - called after the selection was stored
 * @returns the dialog
 */
function TerminalUsersDialog({
	terminal,
	onClose,
	onSaved,
}: {
	terminal: AdminTerminal;
	onClose: () => void;
	onSaved: () => Promise<void>;
}): React.JSX.Element {
	const { t } = useTranslation();
	const employees = useQuery({ queryKey: ["admin", "users", "active"], queryFn: () => api.users(false) });
	const [chosen, setChosen] = useState<number[]>(terminal.userIds);

	const save = useMutation({
		mutationFn: () => api.setTerminalUsers(terminal.id, chosen),
		onSuccess: onSaved,
	});

	return (
		<Dialog
			open
			onClose={onClose}
			fullWidth
		>
			<DialogTitle>{`${t("admin.terminal.users")} · ${terminal.name}`}</DialogTitle>
			<DialogContent>
				<Stack
					spacing={1}
					sx={{ mt: 1 }}
				>
					<Typography
						variant="body2"
						color="text.secondary"
					>
						{t("admin.terminal.usersHint")}
					</Typography>
					<EmployeePicker
						users={employees.data ?? []}
						chosen={chosen}
						onChange={setChosen}
					/>
					<ErrorAlert error={employees.error ?? save.error} />
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={save.isPending}
					onClick={() => save.mutate()}
				>
					{t("common.save")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}

/**
 * Kiosk terminals: create a device, show its token once and revoke it again.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the terminal tab
 */
function TerminalsTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const terminals = useQuery({ queryKey: ["admin", "terminals"], queryFn: () => api.terminals() });
	const employees = useQuery({ queryKey: ["admin", "users", "active"], queryFn: () => api.users(false) });
	const [creating, setCreating] = useState(false);
	const [revoking, setRevoking] = useState<AdminTerminal | null>(null);
	const [assigning, setAssigning] = useState<AdminTerminal | null>(null);
	const [issued, setIssued] = useState<{ terminal: AdminTerminal; deviceToken: string } | null>(null);

	const revoke = useMutation({
		mutationFn: (id: number) => api.revokeTerminal(id),
		onSuccess: async () => {
			setRevoking(null);
			await queryClient.invalidateQueries({ queryKey: ["admin", "terminals"] });
		},
	});

	// the address the kiosk is opened with — it carries the token for the first start
	const deviceUrl = issued
		? `${window.location.origin}/terminal?token=${encodeURIComponent(issued.deviceToken)}`
		: "";
	// the same device token opens the simplified presence screen (who is at the workplace right now)
	const presenceUrl = issued
		? `${window.location.origin}/presence?token=${encodeURIComponent(issued.deviceToken)}`
		: "";

	const stale = `${t("common.none")}`;
	const detailsOf = (terminal: AdminTerminal): string => {
		const people =
			terminal.userIds.length === 0
				? t("admin.terminal.usersAll")
				: (employees.data ?? [])
						.filter(user => terminal.userIds.includes(user.id))
						.map(user => user.displayName)
						.join(", ") || t("admin.terminal.usersAll");
		return [terminal.location || stale, formatStamp(terminal.createdAt, language), people].join(" · ");
	};

	return (
		<>
			<ErrorAlert error={terminals.error ?? revoke.error} />

			{issued && (
				<Alert
					severity="success"
					sx={{ mb: 2 }}
				>
					<Typography
						variant="body2"
						gutterBottom
					>
						{t("admin.terminal.tokenOnce")}
					</Typography>
					<Typography
						variant="body2"
						sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
						gutterBottom
					>
						{issued.deviceToken}
					</Typography>
					<Typography
						variant="body2"
						gutterBottom
					>
						{t("admin.terminal.url")}
					</Typography>
					<Typography
						variant="body2"
						sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
					>
						{deviceUrl}
					</Typography>
					<Typography
						variant="body2"
						sx={{ mt: 1 }}
					>
						{t("presence.title")}:
					</Typography>
					<Typography
						variant="body2"
						sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
					>
						{presenceUrl}
					</Typography>
				</Alert>
			)}

			<Box sx={{ mb: 2 }}>
				<Button
					variant="contained"
					startIcon={<TerminalIcon />}
					disabled={creating}
					onClick={() => setCreating(true)}
				>
					{t("admin.terminal.create")}
				</Button>
			</Box>

			<Card>
				<List dense>
					{(terminals.data ?? []).map(terminal => (
						<ActionRow
							key={terminal.id}
							primary={
								<Stack
									direction="row"
									spacing={1}
									alignItems="center"
									sx={{ flexWrap: "wrap", gap: 1 }}
								>
									<Typography>{terminal.name}</Typography>
									{terminal.pinRequired && (
										<Chip
											size="small"
											label={t("admin.terminal.pinRequired")}
										/>
									)}
									{!terminal.isActive && (
										<Chip
											size="small"
											variant="outlined"
											label={t("admin.terminal.revoked")}
										/>
									)}
								</Stack>
							}
							secondary={detailsOf(terminal)}
						>
							{terminal.isActive && (
								<>
									<Button
										size="small"
										onClick={() => setAssigning(terminal)}
									>
										{t("admin.terminal.users")}
									</Button>
									<Button
										size="small"
										color="error"
										onClick={() => setRevoking(terminal)}
									>
										{t("admin.terminal.revoke")}
									</Button>
								</>
							)}
						</ActionRow>
					))}
					{terminals.isLoading && (
						<ListItem>
							<ListItemText secondary={t("common.loading")} />
						</ListItem>
					)}
					{!terminals.isLoading && (terminals.data ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("admin.terminal.empty")} />
						</ListItem>
					)}
				</List>
			</Card>

			{assigning && (
				<TerminalUsersDialog
					terminal={assigning}
					onClose={() => setAssigning(null)}
					onSaved={async () => {
						setAssigning(null);
						await queryClient.invalidateQueries({ queryKey: ["admin", "terminals"] });
					}}
				/>
			)}

			{creating && (
				<CreateTerminalDialog
					onClose={() => setCreating(false)}
					onCreated={async created => {
						setCreating(false);
						setIssued(created);
						await queryClient.invalidateQueries({ queryKey: ["admin", "terminals"] });
					}}
				/>
			)}

			{revoking && (
				<Dialog
					open
					onClose={() => setRevoking(null)}
				>
					<DialogTitle>{t("admin.terminal.revoke")}</DialogTitle>
					<DialogContent>{t("admin.terminal.confirmRevoke", { name: revoking.name })}</DialogContent>
					<DialogActions>
						<Button onClick={() => setRevoking(null)}>{t("common.cancel")}</Button>
						<Button
							color="error"
							variant="contained"
							disabled={revoke.isPending}
							onClick={() => revoke.mutate(revoking.id)}
						>
							{t("admin.terminal.revoke")}
						</Button>
					</DialogActions>
				</Dialog>
			)}
		</>
	);
}

/**
 * Dialog that assigns the roles of an employee.
 *
 * The account of the caller and the last active administrator are special: losing the admin role there would end
 * the administration of the installation, so the dialog says it before anybody tries (the server refuses it, too).
 *
 * @param props - employee, flags, close handler and save handler
 * @param props.user - employee to edit
 * @param props.isSelf - true when the caller edits the own account
 * @param props.lastAdministrator - true when the employee is the only active administrator
 * @param props.onClose - called when the dialog is closed
 * @param props.onSaved - called with the chosen role keys
 * @returns the dialog
 */
function RolesDialog({
	user,
	isSelf,
	lastAdministrator,
	onClose,
	onSaved,
}: {
	user: AdminUser;
	isSelf: boolean;
	lastAdministrator: boolean;
	onClose: () => void;
	onSaved: (roleKeys: string[]) => void;
}): React.JSX.Element {
	const { t } = useTranslation();
	const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: () => api.roles() });
	const [chosen, setChosen] = useState<string[]>(user.roles);
	/** True while the account would lose the admin role. */
	const losesAdmin = user.roles.includes("admin") && !chosen.includes("admin");

	/**
	 * Adds or removes a role.
	 *
	 * @param key - role key
	 * @param checked - true when the role should be granted
	 */
	const toggle = (key: string, checked: boolean): void =>
		setChosen(current => (checked ? [...new Set([...current, key])] : current.filter(entry => entry !== key)));

	return (
		<Dialog
			open
			onClose={onClose}
			fullWidth
		>
			<DialogTitle>{t("admin.user.roles")}</DialogTitle>
			<DialogContent>
				{isSelf && losesAdmin && (
					<Alert
						data-testid="roles-warning"
						severity={lastAdministrator ? "info" : "warning"}
						sx={{ mt: 1 }}
					>
						{lastAdministrator ? t("admin.user.lastAdminRoles") : t("admin.user.selfRoles")}
					</Alert>
				)}
				<Stack
					spacing={1}
					sx={{ mt: 1 }}
				>
					{(roles.data ?? []).map(role => (
						<Stack
							key={role.key}
							direction="row"
							spacing={1}
							alignItems="center"
						>
							<Switch
								checked={chosen.includes(role.key)}
								inputProps={{ "aria-label": t(`role.${role.key}`, role.name) }}
								onChange={(_event, checked) => toggle(role.key, checked)}
							/>
							<Typography>{t(`role.${role.key}`, role.name)}</Typography>
						</Stack>
					))}
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={chosen.length === 0 || (lastAdministrator && losesAdmin)}
					onClick={() => onSaved(chosen)}
				>
					{t("common.save")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}

/**
 * Public holidays of a year: list, add and remove.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the holiday tab
 */
function HolidaysTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [year, setYear] = useState(String(new Date().getFullYear()));
	const [date, setDate] = useState("");
	const [name, setName] = useState("");
	const [region, setRegion] = useState("");

	const holidays = useQuery({
		queryKey: ["admin", "holidays", year],
		queryFn: () => api.holidays(Number(year)),
	});

	/** Refreshes the list of the shown year. */
	const reload = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["admin", "holidays", year] });
	};

	const add = useMutation({
		mutationFn: () =>
			api.createHoliday({
				date: date.trim(),
				name: name.trim(),
				...(region.trim() ? { region: region.trim() } : {}),
			}),
		onSuccess: async () => {
			// the list shows one year; a holiday of another one would be saved and missing from it right away
			const addedYear = date.trim().slice(0, 4);
			setDate("");
			setName("");
			setRegion("");
			if (addedYear !== year) {
				setYear(addedYear);
			}
			await reload();
		},
	});

	const remove = useMutation({
		mutationFn: (id: number) => api.deleteHoliday(id),
		onSuccess: reload,
	});

	const ready = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) && name.trim().length > 0;

	return (
		<>
			<ErrorAlert error={holidays.error ?? add.error ?? remove.error} />

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Stack
						direction={{ xs: "column", sm: "row" }}
						spacing={2}
						sx={{ mt: 1 }}
					>
						<TextField
							label={t("admin.holiday.year")}
							value={year}
							onChange={event => setYear(event.target.value.replace(/\D/g, "").slice(0, 4))}
							sx={{ width: 140 }}
						/>
						<TextField
							label={t("admin.holiday.date")}
							type="date"
							value={date}
							size="small"
							InputLabelProps={{ shrink: true }}
							sx={{ width: 200 }}
							onChange={event => setDate(event.target.value)}
						/>
						<TextField
							label={t("admin.holiday.name")}
							value={name}
							onChange={event => setName(event.target.value)}
							fullWidth
						/>
						<TextField
							label={t("admin.holiday.region")}
							value={region}
							onChange={event => setRegion(event.target.value)}
							sx={{ width: 200 }}
						/>
					</Stack>
					<Box sx={{ mt: 2 }}>
						<Button
							variant="contained"
							disabled={!ready || add.isPending}
							onClick={() => add.mutate()}
						>
							{t("admin.holiday.add")}
						</Button>
					</Box>
				</CardContent>
			</Card>

			<Card>
				<List dense>
					{(holidays.data ?? []).map(holiday => (
						<ActionRow
							key={holiday.id}
							primary={`${formatDate(holiday.date, language)} · ${
								holiday.key ? t(`holiday.${holiday.key}`, { defaultValue: holiday.name }) : holiday.name
							}`}
							secondary={holiday.region ?? t("common.none")}
						>
							<Button
								size="small"
								color="error"
								onClick={() => remove.mutate(holiday.id)}
							>
								{t("admin.tag.delete")}
							</Button>
						</ActionRow>
					))}
					{!holidays.isLoading && (holidays.data ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("admin.holiday.empty")} />
						</ListItem>
					)}
				</List>
			</Card>
		</>
	);
}

/**
 * Edits a badge: employee, label and validity.
 *
 * The link signs the owner and the expiry, so a different employee or a new validity issues a new link — the answer
 * carries it, and everything handed out before stops working. A label on its own leaves the link alone.
 *
 * @param props - badge to edit, close handler and success handler
 * @param props.tag - badge to edit
 * @param props.onClose - called when the dialog is closed
 * @param props.onSaved - called with the answer of the server after a successful change
 * @returns the dialog
 */
function TagDialog({
	tag,
	onClose,
	onSaved,
}: {
	tag: RfidTagRecord;
	onClose: () => void;
	onSaved: (saved: { tag: RfidTagRecord; token?: string; url?: string }) => Promise<void>;
}): React.JSX.Element {
	const { t } = useTranslation();
	const people = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users() });
	const [userId, setUserId] = useState(tag.userId === null ? "" : String(tag.userId));
	const [label, setLabel] = useState(tag.label ?? "");
	const [ttlDays, setTtlDays] = useState("");

	const days = ttlDays.trim() === "" ? undefined : Number(ttlDays);
	const invalid = !userId || (days !== undefined && (!Number.isInteger(days) || days <= 0));

	const save = useMutation({
		mutationFn: () =>
			api.updateTag(tag.id, {
				userId: Number(userId),
				// an empty field clears the label, that is what the server understands as `null`
				label: label.trim() ? label.trim() : null,
				...(days === undefined ? {} : { ttlDays: days }),
			}),
		onSuccess: onSaved,
	});

	// a new link for a badge that was lost, expired or revoked — the link handed out before stops working
	const reissue = useMutation({
		mutationFn: () => api.reissueTagLink(tag.id),
		onSuccess: onSaved,
	});

	return (
		<Dialog
			open
			onClose={onClose}
			fullWidth
		>
			<DialogTitle>{`${t("admin.tag.editTitle")} · ${tag.label ?? tag.uid}`}</DialogTitle>
			<DialogContent>
				<Stack
					spacing={2}
					sx={{ mt: 1 }}
				>
					<Typography
						variant="body2"
						color="text.secondary"
					>
						{t("admin.tag.editHint")}
					</Typography>
					<TextField
						select
						label={t("admin.tag.user")}
						value={userId}
						onChange={event => setUserId(event.target.value)}
					>
						{(people.data ?? []).map(user => (
							<MenuItem
								key={user.id}
								value={String(user.id)}
							>
								{`${user.displayName} (${user.login})`}
							</MenuItem>
						))}
					</TextField>
					<TextField
						label={t("admin.tag.label")}
						value={label}
						onChange={event => setLabel(event.target.value)}
					/>
					<TextField
						label={t("admin.tag.validityDays")}
						type="number"
						value={ttlDays}
						onChange={event => setTtlDays(event.target.value)}
					/>
					<ErrorAlert error={people.error ?? save.error ?? reissue.error} />
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button
					onClick={() => reissue.mutate()}
					disabled={reissue.isPending}
					sx={{ mr: "auto" }}
				>
					{t("admin.tag.reissue")}
				</Button>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={invalid || save.isPending}
					onClick={() => save.mutate()}
				>
					{t("common.save")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}

/**
 * Badges of the employees: create a signed link for a tag, list and remove them.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the badge tab
 */
function TagsTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const tags = useQuery({ queryKey: ["admin", "tags"], queryFn: () => api.rfidTags() });
	const people = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users() });
	const [userId, setUserId] = useState("");
	const [label, setLabel] = useState("");
	const [issued, setIssued] = useState<{ token: string; url: string; reissued: boolean } | null>(null);
	const [qr, setQr] = useState<string | null>(null);
	const [editing, setEditing] = useState<RfidTagRecord | null>(null);

	/** Refreshes the list of the badges. */
	const reload = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["admin", "tags"] });
	};

	/**
	 * Builds the link from the address this administration is reached with — scheme, host and port come from the
	 * browser, so it works on plain HTTP and behind a reverse proxy alike and no server side guess can point at a
	 * scheme the instance does not serve.
	 *
	 * @param token - signed token of the badge
	 * @returns the link to write onto the badge
	 */
	const linkFor = (token: string): string => `${window.location.origin}/?tag=${token}`;

	/**
	 * Shows the link of a badge that was just created or given a new one.
	 *
	 * @param token - signed token of the badge
	 * @param reissued - true when the badge had a link before, which is dead now
	 */
	const showLink = (token: string, reissued: boolean): void => {
		setIssued({ token, url: linkFor(token), reissued });
	};

	// The code is drawn in the browser: it works offline and no service sees the link.
	useEffect(() => {
		if (!issued) {
			setQr(null);
			return undefined;
		}
		let cancelled = false;
		QRCode.toDataURL(issued.url, { margin: 1, width: 240 })
			.then(dataUrl => {
				if (!cancelled) {
					setQr(dataUrl);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setQr(null);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [issued]);

	const create = useMutation({
		mutationFn: () => api.createTag({ userId: Number(userId), ...(label.trim() ? { label: label.trim() } : {}) }),
		onSuccess: async created => {
			showLink(created.token, false);
			setLabel("");
			await reload();
		},
	});

	const remove = useMutation({
		mutationFn: (id: number) => api.deleteTag(id),
		onSuccess: reload,
	});

	// a badge that was revoked can be taken out of the list for good
	const purge = useMutation({
		mutationFn: (id: number) => api.deleteTagPermanently(id),
		onSuccess: reload,
	});

	/**
	 * Name of the employee a badge belongs to.
	 *
	 * @param id - user id
	 * @returns shown name
	 */
	const nameOf = (id: number): string => (people.data ?? []).find(user => user.id === id)?.displayName ?? `#${id}`;

	return (
		<>
			<ErrorAlert error={tags.error ?? create.error ?? remove.error ?? purge.error} />

			{issued && (
				<Alert
					severity="success"
					sx={{ mb: 2 }}
				>
					<Typography
						variant="body2"
						gutterBottom
					>
						{t("admin.tag.linkOnce")}
					</Typography>
					<Typography
						variant="body2"
						sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
					>
						{issued.url}
					</Typography>
					{qr && (
						<Box sx={{ mt: 1.5 }}>
							<img
								src={qr}
								alt={t("admin.tag.qrAlt")}
								width={200}
								height={200}
								style={{ display: "block", borderRadius: 4 }}
							/>
						</Box>
					)}
					{issued.reissued && (
						<Typography
							variant="body2"
							sx={{ mt: 1 }}
						>
							{t("admin.tag.oldLinkDead")}
						</Typography>
					)}
				</Alert>
			)}

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Stack
						direction={{ xs: "column", sm: "row" }}
						spacing={2}
						sx={{ mt: 1 }}
					>
						<TextField
							select
							label={t("admin.tag.user")}
							value={userId}
							onChange={event => setUserId(event.target.value)}
							sx={{ minWidth: 220 }}
						>
							{(people.data ?? []).map(user => (
								<MenuItem
									key={user.id}
									value={String(user.id)}
								>
									{`${user.displayName} (${user.login})`}
								</MenuItem>
							))}
						</TextField>
						<TextField
							label={t("admin.tag.label")}
							value={label}
							onChange={event => setLabel(event.target.value)}
							fullWidth
						/>
						<Button
							variant="contained"
							disabled={!userId || create.isPending}
							onClick={() => create.mutate()}
						>
							{t("admin.tag.create")}
						</Button>
					</Stack>
				</CardContent>
			</Card>

			<Card>
				<List dense>
					{(tags.data ?? []).map(tag => {
						const expired = tag.expiresAt !== null && tag.expiresAt * 1000 < Date.now();
						const state =
							tag.isActive === false
								? t("admin.tag.revoked")
								: expired
									? t("admin.tag.expired")
									: t("admin.tag.active");
						const until = tag.expiresAt ? formatStamp(tag.expiresAt, language) : t("common.none");
						const used = tag.lastUsedAt ? formatStamp(tag.lastUsedAt, language) : t("common.none");
						return (
							<ActionRow
								key={tag.id}
								primary={`${tag.label ?? tag.uid ?? `#${tag.id}`} · ${nameOf(tag.userId)}`}
								secondary={`${state} · ${t("admin.tag.lastUsed")}: ${used} · ${tag.uid ?? t("common.none")} · ${until}`}
							>
								<Button
									size="small"
									onClick={() => setEditing(tag)}
								>
									{t("admin.tag.edit")}
								</Button>
								{tag.isActive !== false && (
									<Button
										size="small"
										color="error"
										onClick={() => remove.mutate(tag.id)}
									>
										{t("admin.tag.delete")}
									</Button>
								)}
								{tag.isActive === false && (
									<Button
										size="small"
										color="error"
										onClick={() => purge.mutate(tag.id)}
									>
										{t("admin.tag.remove")}
									</Button>
								)}
							</ActionRow>
						);
					})}
					{!tags.isLoading && (tags.data ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("admin.tag.empty")} />
						</ListItem>
					)}
				</List>
			</Card>

			{editing && (
				<TagDialog
					tag={editing}
					onClose={() => setEditing(null)}
					onSaved={async saved => {
						setEditing(null);
						// a new employee or a new validity answers with a new link: show it like a fresh badge
						if (saved.token) {
							showLink(saved.token, true);
						}
						await reload();
					}}
				/>
			)}
		</>
	);
}

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
function TriggersTab({ language }: { language: string }): React.JSX.Element {
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
function AutomationRulesCard({
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

/**
 * Text key of a picture problem.
 *
 * @param problem - reason reported by `prepareImage`
 * @returns text key
 */
function imageProblemText(problem: ImageProblem): string {
	if (problem === "type") {
		return "admin.brand.imageType";
	}
	return problem === "tooLarge" ? "admin.brand.imageTooLarge" : "admin.brand.imageUnreadable";
}

/**
 * Button that picks a picture and prepares it for the server.
 *
 * A picture straight from a phone is far bigger than the API accepts, so `prepareImage` scales it down and this
 * field reports what happened.
 *
 * @param props - label, limit and handlers
 * @param props.label - text of the button
 * @param props.maxBytes - limit of the data URL (the same value the server checks)
 * @param props.hint - optional text under the button
 * @param props.onChange - called with the prepared data URL
 * @param props.disabled - true without the right to change the value
 * @returns the field
 */
function PictureField({
	label,
	maxBytes,
	hint,
	onChange,
	disabled,
}: {
	label: string;
	maxBytes: number;
	hint?: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const [problem, setProblem] = useState<ImageProblem | null>(null);
	const [resized, setResized] = useState("");

	return (
		<Stack spacing={1}>
			<Button
				variant="outlined"
				component="label"
				disabled={disabled === true}
				sx={{ alignSelf: "flex-start" }}
			>
				{label}
				<input
					hidden
					type="file"
					accept="image/png,image/jpeg,image/webp,image/gif"
					onChange={event => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (!file) {
							return;
						}
						setProblem(null);
						setResized("");
						void prepareImage(file, maxBytes).then(result => {
							if (!result.ok) {
								setProblem(result.problem);
								return;
							}
							onChange(result.image.dataUrl);
							if (result.image.resized) {
								setResized(
									t("admin.brand.imageResized", {
										size: formatSize(result.image.bytes, i18n.language),
									}),
								);
							}
						});
					}}
				/>
			</Button>
			{hint && (
				<Typography
					variant="body2"
					color="text.secondary"
				>
					{hint}
				</Typography>
			)}
			{resized && (
				<Typography
					variant="body2"
					color="text.secondary"
				>
					{resized}
				</Typography>
			)}
			{problem && <Alert severity="warning">{t(imageProblemText(problem))}</Alert>}
		</Stack>
	);
}

/**
 * Picks a picture of the branding (logo or background).
 *
 * @param props - label, current value, limit and handlers
 * @param props.label - text of the button
 * @param props.value - current data URL, empty when nothing is set
 * @param props.maxBytes - limit of the data URL (the same value the server checks)
 * @param props.onChange - called with the new data URL; an empty string removes the picture
 * @param props.disabled - true without the right to change settings
 * @returns the field
 */
function BrandImageField({
	label,
	value,
	maxBytes,
	onChange,
	disabled,
}: {
	label: string;
	value: string;
	maxBytes: number;
	onChange: (value: string) => void;
	disabled: boolean;
}): React.JSX.Element {
	const { t } = useTranslation();

	return (
		<Stack
			direction={{ xs: "column", sm: "row" }}
			spacing={2}
			sx={{ alignItems: { sm: "center" } }}
		>
			<PictureField
				label={label}
				maxBytes={maxBytes}
				onChange={onChange}
				disabled={disabled}
			/>
			{value !== "" && (
				<>
					<Box
						component="img"
						src={value}
						alt=""
						sx={{ height: 40, maxWidth: 160, objectFit: "contain", border: 1, borderColor: "divider" }}
					/>
					<Button
						color="inherit"
						title={t("admin.settings.brandImageRemove")}
						disabled={disabled}
						onClick={() => onChange("")}
					>
						{t("admin.settings.brandImageRemove")}
					</Button>
				</>
			)}
		</Stack>
	);
}

/**
 * Settings whose label already exists somewhere else, so the raw editor does not repeat the text.
 */
const RAW_SETTING_LABEL_KEYS: Record<string, string> = {
	pause_mode: "admin.settings.pauseModeTitle",
};

/**
 * One raw instance setting: a readable label with the technical name in the small line below it.
 *
 * @param props - setting, value, write state and layout
 * @param props.settingKey - technical name of the setting
 * @param props.value - current value
 * @param props.disabled - true when the caller may not write
 * @param props.onChange - called with the new value
 * @param props.fullLine - true to run over the whole line (the time zone needs the room)
 * @returns the field
 */
function RawSettingField({
	settingKey,
	value,
	disabled,
	onChange,
	fullLine = false,
}: {
	settingKey: string;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
	fullLine?: boolean;
}): React.JSX.Element {
	const { t } = useTranslation();
	const labelKey = RAW_SETTING_LABEL_KEYS[settingKey] ?? `admin.settings.setting.${settingKey}`;
	return (
		<TextField
			label={t(labelKey, { defaultValue: settingKey })}
			// the technical name stays visible: this block is the raw editor of the instance settings
			helperText={settingKey}
			value={value}
			onChange={event => onChange(event.target.value)}
			disabled={disabled}
			size="small"
			fullWidth
			{...(fullLine ? { sx: { gridColumn: { xs: "auto", md: "1 / -1" } } } : {})}
		/>
	);
}

/**
 * Instance settings: the font for the PDF statements and a technical editor for the rest.
 *
 * @returns the settings tab
 */
/**
 * Shows and changes the absence types: code, name, pay, factor and whether the type uses up the vacation.
 *
 * @param props - types, permission and the save callback
 * @param props.types - types as they are shown
 * @param props.disabled - true when the caller may not change types
 * @param props.onSaved - called after a type was stored
 * @returns the card with the list of types
 */
function AbsenceTypesCard({
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

function SettingsTab(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { permissions } = useSession();
	const mayEdit = hasPermission(permissions, "settings.edit");
	const queryClient = useQueryClient();
	const settings = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api.settings() });
	const pauseRules = useQuery({ queryKey: ["admin", "pauseRules"], queryFn: () => api.pauseRules() });
	// the settings read leaves the large pictures out, so the fields take their pictures from the branding route
	const branding = useQuery({ queryKey: ["branding"], queryFn: () => api.branding() });
	const [draft, setDraft] = useState<Record<string, string>>({});
	// `null` shows what the server has; the first change keeps a local copy until it is saved
	const [rules, setRules] = useState<PauseRule[] | null>(null);
	const shownRules = rules ?? pauseRules.data ?? [];

	const savePauseRules = useMutation({
		mutationFn: (list: PauseRule[]) => api.savePauseRules(list),
		onSuccess: async () => {
			setRules(null);
			await queryClient.invalidateQueries({ queryKey: ["admin", "pauseRules"] });
		},
	});

	// automation rules: the adapter follows them on its own, the runs are its log
	const people = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users() });
	const automations = useQuery({ queryKey: ["admin", "automations"], queryFn: () => api.automationRules() });
	const automationRuns = useQuery({ queryKey: ["admin", "automationRuns"], queryFn: () => api.automationRuns() });
	const absenceTypes = useQuery({ queryKey: ["absence-types", "all"], queryFn: () => api.absenceTypes(true) });
	const [automationDraft, setAutomationDraft] = useState<AutomationRule[] | null>(null);
	const shownAutomations = automationDraft ?? automations.data ?? [];

	const saveAutomations = useMutation({
		mutationFn: (list: AutomationRule[]) => api.saveAutomationRules(list),
		onSuccess: async () => {
			setAutomationDraft(null);
			await queryClient.invalidateQueries({ queryKey: ["admin", "automations"] });
			await queryClient.invalidateQueries({ queryKey: ["admin", "automationRuns"] });
		},
	});

	const save = useMutation({
		mutationFn: (patch: Record<string, string>) => api.updateSettings(patch),
		onSuccess: async () => {
			setDraft({});
			await queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
			// logo, background and colour are painted by the app shell and shown by the kiosk screens
			await queryClient.invalidateQueries({ queryKey: ["branding"] });
		},
	});

	if (settings.isLoading) {
		return <Loading />;
	}

	const values = settings.data ?? {};

	// an uploaded picture is in the change set; otherwise the stored picture comes from the branding route
	const currentLogo = draft.brand_logo ?? branding.data?.logoUrl ?? "";
	const currentBackground = draft.brand_background ?? branding.data?.backgroundUrl ?? "";

	/**
	 * Keeps one setting in the pending change set.
	 *
	 * @param key - name of the setting
	 * @param value - new value
	 */
	const change = (key: string, value: string): void => setDraft(current => ({ ...current, [key]: value }));

	return (
		<>
			<ErrorAlert
				error={settings.error ?? branding.error ?? save.error ?? pauseRules.error ?? savePauseRules.error}
			/>
			{save.isSuccess && (
				<Alert
					severity="success"
					sx={{ mb: 2 }}
				>
					{t("admin.settings.saved")}
				</Alert>
			)}

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.settings.branding")}
					</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
						gutterBottom
					>
						{t("admin.settings.brandingHint")}
					</Typography>
					<Stack spacing={2}>
						<BrandImageField
							label={t("admin.settings.brandLogo")}
							value={currentLogo}
							maxBytes={BRANDING_MAX_BYTES}
							onChange={value => change("brand_logo", value)}
							disabled={!mayEdit}
						/>
						<BrandImageField
							label={t("admin.settings.brandBackground")}
							value={currentBackground}
							maxBytes={BRANDING_MAX_BYTES}
							onChange={value => change("brand_background", value)}
							disabled={!mayEdit}
						/>
						<Stack
							direction="row"
							spacing={2}
							sx={{ alignItems: "center" }}
						>
							<TextField
								label={t("admin.settings.brandColor")}
								helperText={t("admin.settings.brandColorHint")}
								value={draft.brand_color ?? values.brand_color ?? ""}
								onChange={event => change("brand_color", event.target.value)}
								disabled={!mayEdit}
								sx={{ maxWidth: 260 }}
							/>
							{(draft.brand_color ?? values.brand_color ?? "") !== "" && (
								<Box
									sx={{
										width: 32,
										height: 32,
										borderRadius: 1,
										border: 1,
										borderColor: "divider",
										bgcolor: draft.brand_color ?? values.brand_color ?? "transparent",
									}}
								/>
							)}
						</Stack>
						{/* the suggestions save typing: one click sets the colour, the field above stays for anything else */}
						<Stack spacing={1}>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("admin.settings.brandColorPresets")}
							</Typography>
							<Stack
								direction="row"
								sx={{ flexWrap: "wrap", gap: 1, alignItems: "center" }}
							>
								{BRAND_PRESET_COLORS.map(color => (
									<Button
										key={color}
										aria-label={color}
										title={color}
										disabled={!mayEdit}
										onClick={() => change("brand_color", color)}
										sx={{
											minWidth: 40,
											width: 40,
											height: 40,
											p: 0,
											borderRadius: 1,
											border: 2,
											borderColor:
												(draft.brand_color ?? values.brand_color ?? "").toLowerCase() === color
													? "primary.main"
													: "divider",
											bgcolor: color,
											"&:hover": { bgcolor: color },
										}}
									/>
								))}
								<Button
									color="inherit"
									title={t("admin.settings.brandColorDefaultHint")}
									disabled={!mayEdit}
									onClick={() => {
										// "default" also takes the background picture away: one click leads back to the plain look
										change("brand_color", "");
										change("brand_background", "");
									}}
								>
									{t("admin.settings.brandColorDefault")}
								</Button>
							</Stack>
						</Stack>
					</Stack>
				</CardContent>
			</Card>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<TextField
						label={t("admin.settings.fontPath")}
						helperText={t("admin.settings.fontPathHint")}
						value={draft.report_font_path ?? values.report_font_path ?? ""}
						onChange={event => change("report_font_path", event.target.value)}
						disabled={!mayEdit}
						fullWidth
					/>
				</CardContent>
			</Card>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.settings.advanced")}
					</Typography>
					<Box
						sx={{
							display: "grid",
							gap: 2,
							// three settings per line on a wide screen — the values are short — and one on a phone
							gridTemplateColumns: {
								xs: "1fr",
								sm: "repeat(2, minmax(0, 1fr))",
								md: "repeat(3, minmax(0, 1fr))",
							},
						}}
					>
						{Object.keys(values)
							.filter(key => !key.startsWith("brand_") && !key.endsWith("timezone"))
							.sort()
							.map(key => (
								<RawSettingField
									key={key}
									settingKey={key}
									value={draft[key] ?? values[key] ?? ""}
									disabled={!mayEdit}
									onChange={next => change(key, next)}
								/>
							))}
						{/* the time zone carries the longest value and gets a line of its own */}
						{Object.keys(values)
							.filter(key => key.endsWith("timezone"))
							.map(key => (
								<RawSettingField
									key={key}
									settingKey={key}
									value={draft[key] ?? values[key] ?? ""}
									disabled={!mayEdit}
									onChange={next => change(key, next)}
									fullLine
								/>
							))}
					</Box>
				</CardContent>
			</Card>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.settings.pauseRules")}
					</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
						gutterBottom
					>
						{t("admin.settings.pauseRulesHint")}
					</Typography>
					<PauseRuleTable
						rules={shownRules}
						disabled={!mayEdit}
						saving={savePauseRules.isPending}
						onChange={setRules}
						onSave={() => savePauseRules.mutate(shownRules)}
					/>
				</CardContent>
			</Card>

			<AutomationRulesCard
				rules={shownAutomations}
				runs={automationRuns.data ?? []}
				people={people.data ?? []}
				disabled={!mayEdit}
				saving={saveAutomations.isPending}
				onChange={setAutomationDraft}
				onSave={() => saveAutomations.mutate(shownAutomations)}
				language={i18n.language}
			/>

			<AbsenceTypesCard
				types={absenceTypes.data ?? []}
				disabled={!hasPermission(permissions, "absence.manage_types")}
				onSaved={() => void queryClient.invalidateQueries({ queryKey: ["absence-types"] })}
			/>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.settings.pauseMode")}
					</Typography>
					<TextField
						select
						fullWidth
						label={t("admin.settings.pauseModeTitle")}
						helperText={t("admin.settings.pauseModeHint")}
						value={draft.pause_mode ?? values.pause_mode ?? "auto"}
						onChange={event => change("pause_mode", event.target.value)}
						disabled={!mayEdit}
					>
						{["auto", "punched", "staffel"].map(mode => (
							<MenuItem
								key={mode}
								value={mode}
							>
								{t(`admin.settings.pauseMode.${mode}`)}
							</MenuItem>
						))}
					</TextField>
				</CardContent>
			</Card>

			<Button
				variant="contained"
				disabled={!mayEdit || Object.keys(draft).length === 0 || save.isPending}
				onClick={() => save.mutate(draft)}
			>
				{t("common.save")}
			</Button>
		</>
	);
}

/**
 * Database backups: list, download, upload, restore for the next start and a button that takes one now.
 *
 * A restore needs a closed database, so this screen swaps nothing: it queues a file and says that the instance
 * has to be restarted. A file of the list is chosen or a downloaded one is uploaded — the upload is the way back
 * for a machine that lost its data directory. Deleting a file is possible as well; the retention keeps doing its
 * own job in the background.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the backup tab
 */
function BackupTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [toRestore, setToRestore] = useState<string | null>(null);
	const [toDelete, setToDelete] = useState<string | null>(null);
	const [reason, setReason] = useState("");
	// the file dialog is opened by a button, so the input itself stays hidden
	const fileInput = useRef<HTMLInputElement | null>(null);
	const backups = useQuery({ queryKey: ["admin", "backups"], queryFn: () => api.backups() });
	const create = useMutation({
		mutationFn: () => api.createBackup(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
		},
	});
	// queueing a restore changes the list: it then reports the file that waits for the next start
	const restore = useMutation({
		mutationFn: (name: string) => api.restoreBackup(name, reason.trim() || undefined),
		onSuccess: async () => {
			setToRestore(null);
			setReason("");
			await queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
		},
	});
	const download = useMutation({
		mutationFn: (name: string) => api.downloadBackup(name),
		onSuccess: file => saveBlob(file.blob, file.fileName),
	});
	// the adapter checks the uploaded file before it is queued: a file that is not a backup fails right here
	const upload = useMutation({
		mutationFn: (file: File) => api.uploadBackup(file),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
		},
	});
	// a deleted file is gone for good, so the screen asks first
	const remove = useMutation({
		mutationFn: (name: string) => api.deleteBackup(name),
		onSuccess: async () => {
			setToDelete(null);
			await queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
		},
	});

	if (backups.isLoading) {
		return <Loading />;
	}

	const pending = backups.data?.pending ?? null;

	return (
		<>
			<ErrorAlert
				error={backups.error ?? create.error ?? restore.error ?? download.error ?? upload.error ?? remove.error}
			/>
			{/* a queued restore is applied while the adapter starts, and only the administrator can start it */}
			{pending && (
				<Alert
					severity="warning"
					sx={{ mb: 2 }}
				>
					{t("admin.backup.pendingHint", {
						name: pending.name,
						users: pending.users,
						entries: pending.entries,
					})}
				</Alert>
			)}
			{create.isSuccess && (
				<Alert
					severity="success"
					sx={{ mb: 2 }}
				>
					{t("admin.backup.done", {
						name: create.data.backup.name,
						removed: create.data.removed.length,
					})}
				</Alert>
			)}

			<Box sx={{ mb: 2 }}>
				<Stack
					direction="row"
					spacing={1}
					alignItems="center"
					flexWrap="wrap"
					useFlexGap
				>
					<Button
						variant="contained"
						startIcon={create.isPending ? <CircularProgress size={18} /> : <BackupIcon />}
						disabled={create.isPending}
						onClick={() => create.mutate()}
					>
						{t("admin.backup.create")}
					</Button>
					{/* the way back when the data directory is gone: a downloaded file is picked and queued */}
					<Button
						variant="outlined"
						startIcon={upload.isPending ? <CircularProgress size={18} /> : <UploadFileIcon />}
						disabled={upload.isPending}
						onClick={() => fileInput.current?.click()}
					>
						{t("admin.backup.upload")}
					</Button>
					<input
						ref={fileInput}
						type="file"
						accept=".sqlite,application/octet-stream"
						hidden
						onChange={event => {
							const file = event.target.files?.[0];
							// the same file may be chosen twice; without the reset the second try would not fire
							event.target.value = "";
							if (file) {
								upload.mutate(file);
							}
						}}
					/>
				</Stack>
				<Typography
					variant="body2"
					color="text.secondary"
					sx={{ mt: 1 }}
				>
					{t("admin.backup.uploadHint")}
				</Typography>
			</Box>

			<Card>
				<List dense>
					{(backups.data?.backups ?? []).map(file => (
						<ListItem key={file.name}>
							{/* the actions are siblings of the text, not `secondaryAction`: that one floats and would
							    lie on the long file name on a narrow screen */}
							<ListItemText
								primary={file.name}
								secondary={`${formatStamp(file.createdAt, language)} · ${formatSize(file.sizeBytes, language)}`}
							/>
							<Stack
								direction="row"
								spacing={0.5}
								alignItems="center"
							>
								{download.isPending && download.variables === file.name && (
									<CircularProgress size={16} />
								)}
								<IconButton
									size="small"
									title={t("admin.backup.download")}
									disabled={download.isPending}
									onClick={() => download.mutate(file.name)}
								>
									<DownloadIcon fontSize="small" />
								</IconButton>
								<IconButton
									size="small"
									title={t("admin.backup.restore")}
									disabled={restore.isPending}
									onClick={() => setToRestore(file.name)}
								>
									<RestoreIcon fontSize="small" />
								</IconButton>
								<IconButton
									size="small"
									title={t("admin.backup.delete")}
									disabled={remove.isPending}
									onClick={() => setToDelete(file.name)}
								>
									<DeleteIcon fontSize="small" />
								</IconButton>
							</Stack>
						</ListItem>
					))}
					{(backups.data?.backups ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("admin.backup.empty")} />
						</ListItem>
					)}
				</List>
			</Card>

			<Typography
				variant="body2"
				color="text.secondary"
				sx={{ mt: 2 }}
			>
				{t("admin.backup.retention", { days: backups.data?.retentionDays ?? 0 })}
			</Typography>

			{/* the confirmation carries the reason: it lands in the audit trail of the adapter */}
			<Dialog
				open={toRestore !== null}
				onClose={() => setToRestore(null)}
			>
				<DialogTitle>{t("admin.backup.restoreTitle")}</DialogTitle>
				<DialogContent>
					<DialogContentText sx={{ mb: 2 }}>
						{t("admin.backup.restoreConfirm", { name: toRestore ?? "" })}
					</DialogContentText>
					<TextField
						fullWidth
						label={t("corrections.reason")}
						helperText={t("corrections.reasonHint")}
						value={reason}
						onChange={event => setReason(event.target.value)}
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setToRestore(null)}>{t("common.cancel")}</Button>
					<Button
						variant="contained"
						disabled={restore.isPending}
						onClick={() => toRestore && restore.mutate(toRestore)}
					>
						{t("admin.backup.restore")}
					</Button>
				</DialogActions>
			</Dialog>

			{/* the file is gone afterwards, so the dialog names it and leaves no doubt about that */}
			<Dialog
				open={toDelete !== null}
				onClose={() => setToDelete(null)}
			>
				<DialogTitle>{t("admin.backup.deleteTitle")}</DialogTitle>
				<DialogContent>
					<DialogContentText>{t("admin.backup.deleteConfirm", { name: toDelete ?? "" })}</DialogContentText>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setToDelete(null)}>{t("common.cancel")}</Button>
					<Button
						variant="contained"
						color="error"
						disabled={remove.isPending}
						onClick={() => toDelete && remove.mutate(toDelete)}
					>
						{t("admin.backup.delete")}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
}

/**
 * Shows the administration.
 *
 * @returns the admin screen
 */
export function Admin(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { permissions } = useSession();
	const [tab, setTab] = useState(0);

	// only the tabs the caller may use become part of the screen; the server checks each request again
	const tabs: { label: string; render: () => React.JSX.Element }[] = [];
	if (hasPermission(permissions, "user.view")) {
		tabs.push({ label: t("admin.users"), render: () => <UsersTab language={i18n.language} /> });
	}
	// correcting punches is the everyday administrative task, so it sits right next to the employees
	if (hasPermission(permissions, "time.edit_other")) {
		tabs.push({ label: t("admin.corrections"), render: () => <CorrectionsTab language={i18n.language} /> });
	}
	// absences: the requests of the employees wait here for their decision, and “who is away” is answered here
	if (hasPermission(permissions, "absence.approve")) {
		tabs.push({ label: t("admin.absences.title"), render: () => <AbsencesTab language={i18n.language} /> });
	}
	if (hasPermission(permissions, "terminal.manage")) {
		tabs.push({ label: t("admin.terminals"), render: () => <TerminalsTab language={i18n.language} /> });
	}
	if (hasPermission(permissions, "settings.view")) {
		tabs.push({ label: t("admin.settings"), render: () => <SettingsTab /> });
	}
	if (hasPermission(permissions, "holiday.manage")) {
		tabs.push({ label: t("admin.holidays"), render: () => <HolidaysTab language={i18n.language} /> });
	}
	if (hasPermission(permissions, "rfid.manage")) {
		tabs.push({ label: t("admin.tags"), render: () => <TagsTab language={i18n.language} /> });
	}
	// rules that turn a state of another adapter into a punch: fingerprint reader, button, door contact
	if (hasPermission(permissions, "settings.view")) {
		tabs.push({ label: t("admin.triggers"), render: () => <TriggersTab language={i18n.language} /> });
	}
	if (hasPermission(permissions, "backup.run")) {
		tabs.push({ label: t("admin.backup"), render: () => <BackupTab language={i18n.language} /> });
	}

	if (tabs.length === 0) {
		return (
			<AppShell title={t("admin.title")}>
				<Alert severity="info">{t("admin.forbidden")}</Alert>
			</AppShell>
		);
	}

	// a permission change can leave the index behind, so it is clamped to the allowed range
	const active = Math.min(tab, tabs.length - 1);

	return (
		<AppShell title={t("admin.title")}>
			<Tabs
				value={active}
				onChange={(_event, value: number) => setTab(value)}
				// scrollable instead of fullWidth: the labels do not fit a wide window when squeezed, and a
				// clipped tab name is worse than a scrollable row
				variant="scrollable"
				scrollButtons="auto"
				allowScrollButtonsMobile
				sx={{ mb: 2 }}
			>
				{tabs.map(entry => (
					<Tab
						key={entry.label}
						label={entry.label}
					/>
				))}
			</Tabs>

			{tabs[active]?.render()}
		</AppShell>
	);
}
