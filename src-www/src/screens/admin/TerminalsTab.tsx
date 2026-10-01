/**
 * Administration: CreateTerminalDialog, TerminalUsersDialog, TerminalsTab (split out of `Admin.tsx`).
 */

import { ActionRow } from "../../components/ActionRow";
import { type AdminTerminal, api } from "../../api/client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import { ErrorAlert } from "../../components/feedback";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TerminalIcon from "@mui/icons-material/Terminal";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmployeePicker } from "./EmployeePicker";
import { formatStamp } from "./helpers";

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
export function TerminalsTab({ language }: { language: string }): React.JSX.Element {
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
