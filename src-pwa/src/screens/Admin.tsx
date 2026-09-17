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
import BackupIcon from "@mui/icons-material/Backup";
import DownloadIcon from "@mui/icons-material/Download";
import RestoreIcon from "@mui/icons-material/Restore";
import DeleteIcon from "@mui/icons-material/Delete";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import KeyIcon from "@mui/icons-material/Key";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import TerminalIcon from "@mui/icons-material/Terminal";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate, type AdminTerminal } from "../api/client";
import type { AdminUser, CreateUserInput, WorkProfile } from "../api/types";
import { AppShell } from "../components/AppShell";
import { ActionRow } from "../components/ActionRow";
import { ErrorAlert, Loading } from "../components/feedback";
import { saveBlob } from "../components/ReportDownloads";
import { hasPermission, useSession } from "../state/session";

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
								{role.name}
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
				<ErrorAlert error={profile.error ?? save.error} />
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
	const { permissions } = useSession();
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
	// assigning roles is a right of its own (the server checks it again)
	const mayManageRoles = hasPermission(permissions, "user.manage_roles");

	const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users(true) });

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
											label={role}
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
										onChange={() =>
											change.mutate({ id: user.id, patch: { isActive: !user.isActive } })
										}
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
					onClose={() => setRolesUser(null)}
					onSaved={roleKeys => {
						change.mutate({ id: rolesUser.id, patch: { roleKeys } });
						setRolesUser(null);
					}}
				/>
			)}

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
 * @param props - employee, close handler and save handler
 * @param props.user - employee to edit
 * @param props.onClose - called when the dialog is closed
 * @param props.onSaved - called with the chosen role keys
 * @returns the dialog
 */
function RolesDialog({
	user,
	onClose,
	onSaved,
}: {
	user: AdminUser;
	onClose: () => void;
	onSaved: (roleKeys: string[]) => void;
}): React.JSX.Element {
	const { t } = useTranslation();
	const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: () => api.roles() });
	const [chosen, setChosen] = useState<string[]>(user.roles);

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
								onChange={(_event, checked) => toggle(role.key, checked)}
							/>
							<Typography>{role.name}</Typography>
						</Stack>
					))}
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={chosen.length === 0}
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
			setDate("");
			setName("");
			setRegion("");
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
							value={date}
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
							primary={`${formatDate(holiday.date, language)} · ${holiday.name}`}
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
	const [issued, setIssued] = useState<string | null>(null);

	/** Refreshes the list of the badges. */
	const reload = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["admin", "tags"] });
	};

	const create = useMutation({
		mutationFn: () => api.createTag({ userId: Number(userId), ...(label.trim() ? { label: label.trim() } : {}) }),
		onSuccess: async created => {
			setIssued(created.url);
			setLabel("");
			await reload();
		},
	});

	const remove = useMutation({
		mutationFn: (id: number) => api.deleteTag(id),
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
			<ErrorAlert error={tags.error ?? create.error ?? remove.error} />

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
						{issued}
					</Typography>
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
						const until = tag.expiresAt ? formatStamp(tag.expiresAt, language) : t("common.none");
						return (
							<ActionRow
								key={tag.id}
								primary={`${tag.label ?? tag.uid ?? `#${tag.id}`} · ${nameOf(tag.userId)}`}
								secondary={`${tag.uid ?? t("common.none")} · ${until}`}
							>
								<Button
									size="small"
									color="error"
									onClick={() => remove.mutate(tag.id)}
								>
									{t("admin.tag.delete")}
								</Button>
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
		</>
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
						disabled={disabled}
						onClick={() => onChange("")}
					>
						{t("admin.user.photoRemove")}
					</Button>
				</>
			)}
		</Stack>
	);
}

/**
 * Instance settings: the font for the PDF statements and a technical editor for the rest.
 *
 * @returns the settings tab
 */
function SettingsTab(): React.JSX.Element {
	const { t } = useTranslation();
	const { permissions } = useSession();
	const mayEdit = hasPermission(permissions, "settings.edit");
	const queryClient = useQueryClient();
	const settings = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api.settings() });
	const [draft, setDraft] = useState<Record<string, string>>({});

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

	/**
	 * Keeps one setting in the pending change set.
	 *
	 * @param key - name of the setting
	 * @param value - new value
	 */
	const change = (key: string, value: string): void => setDraft(current => ({ ...current, [key]: value }));

	return (
		<>
			<ErrorAlert error={settings.error ?? save.error} />
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
							value={draft.brand_logo ?? values.brand_logo ?? ""}
							maxBytes={BRANDING_MAX_BYTES}
							onChange={value => change("brand_logo", value)}
							disabled={!mayEdit}
						/>
						<BrandImageField
							label={t("admin.settings.brandBackground")}
							value={draft.brand_background ?? values.brand_background ?? ""}
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
									disabled={!mayEdit}
									onClick={() => change("brand_color", "")}
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
					<Stack spacing={2}>
						{Object.keys(values)
							.filter(key => !key.startsWith("brand_"))
							.sort()
							.map(key => (
								<TextField
									key={key}
									label={key}
									value={draft[key] ?? values[key] ?? ""}
									onChange={event => change(key, event.target.value)}
									disabled={!mayEdit}
									size="small"
									fullWidth
								/>
							))}
					</Stack>
				</CardContent>
			</Card>

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
				// scrollable instead of fullWidth: seven labels do not fit a wide window when squeezed, and a
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
