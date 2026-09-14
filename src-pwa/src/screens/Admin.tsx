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
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import BackupIcon from "@mui/icons-material/Backup";
import KeyIcon from "@mui/icons-material/Key";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AdminUser, CreateUserInput } from "../api/types";
import { AppShell } from "../components/AppShell";
import { ErrorAlert, Loading } from "../components/feedback";
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
							<option
								key={role.key}
								value={role.key}
							>
								{role.name}
							</option>
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
function UsersTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const { permissions } = useSession();
	const queryClient = useQueryClient();
	const mayEdit = hasPermission(permissions, "user.edit");
	const mayCreate = hasPermission(permissions, "user.create");
	const [creating, setCreating] = useState(false);
	const [pinUser, setPinUser] = useState<AdminUser | null>(null);
	const [pin, setPin] = useState("");

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

	if (users.isLoading) {
		return <Loading />;
	}

	return (
		<>
			<ErrorAlert error={users.error ?? change.error ?? savePin.error} />

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
						<ListItem
							key={user.id}
							secondaryAction={
								<Stack
									direction="row"
									spacing={1}
									alignItems="center"
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
											<Switch
												checked={user.isActive}
												title={t(user.isActive ? "admin.user.active" : "admin.user.inactive")}
												onChange={() =>
													change.mutate({ id: user.id, patch: { isActive: !user.isActive } })
												}
											/>
										</>
									)}
								</Stack>
							}
						>
							<ListItemText
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
							/>
						</ListItem>
					))}
					{(users.data ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("admin.user.empty")} />
						</ListItem>
					)}
				</List>
			</Card>

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
 * Database backups: list, retention and a button that takes one now.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the backup tab
 */
function BackupTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const backups = useQuery({ queryKey: ["admin", "backups"], queryFn: () => api.backups() });
	const create = useMutation({
		mutationFn: () => api.createBackup(),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["admin", "backups"] });
		},
	});

	if (backups.isLoading) {
		return <Loading />;
	}

	return (
		<>
			<ErrorAlert error={backups.error ?? create.error} />
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
				<Button
					variant="contained"
					startIcon={create.isPending ? <CircularProgress size={18} /> : <BackupIcon />}
					disabled={create.isPending}
					onClick={() => create.mutate()}
				>
					{t("admin.backup.create")}
				</Button>
			</Box>

			<Card>
				<List dense>
					{(backups.data?.backups ?? []).map(file => (
						<ListItem key={file.name}>
							<ListItemText
								primary={file.name}
								secondary={`${formatStamp(file.createdAt, language)} · ${formatSize(file.sizeBytes, language)}`}
							/>
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
	const maySeeUsers = hasPermission(permissions, "user.view");
	const maySeeBackup = hasPermission(permissions, "backup.run");
	const [tab, setTab] = useState(0);

	if (!maySeeUsers && !maySeeBackup) {
		return (
			<AppShell title={t("admin.title")}>
				<Alert severity="info">{t("admin.forbidden")}</Alert>
			</AppShell>
		);
	}

	return (
		<AppShell title={t("admin.title")}>
			<Tabs
				value={tab}
				onChange={(_event, value: number) => setTab(value)}
				variant="fullWidth"
				sx={{ mb: 2 }}
			>
				{maySeeUsers && <Tab label={t("admin.users")} />}
				{maySeeBackup && <Tab label={t("admin.backup")} />}
			</Tabs>

			{/* the tab index follows the visible tabs, so the first allowed one is `0` */}
			{maySeeUsers && tab === 0 && <UsersTab language={i18n.language} />}
			{maySeeBackup && tab === (maySeeUsers ? 1 : 0) && <BackupTab language={i18n.language} />}
		</AppShell>
	);
}
