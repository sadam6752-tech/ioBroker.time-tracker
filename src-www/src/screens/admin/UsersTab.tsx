/**
 * Administration: CreateUserDialog, PauseRuleTable, WorkProfileDialog, UsersTab, RolesDialog (split out of `Admin.tsx`).
 */

import { AVATAR_MAX_BYTES } from "../../components/image-file";
import { ActionRow } from "../../components/ActionRow";
import AddIcon from "@mui/icons-material/Add";
import { type AdminUser, type CreateUserInput, type PauseRule, type WorkProfile } from "../../api/types";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import DeleteIcon from "@mui/icons-material/Delete";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { ErrorAlert, Loading } from "../../components/feedback";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import KeyIcon from "@mui/icons-material/Key";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { api } from "../../api/client";
import { hasPermission, useSession } from "../../state/session";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PictureField } from "./SettingsTab";

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
export function PauseRuleTable({
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

/**
 * The employees of the administration: the list and the dialogs to create and edit them.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the tab
 */
export function UsersTab({ language }: { language: string }): React.JSX.Element {
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
