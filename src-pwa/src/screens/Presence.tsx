/**
 * Presence screen (mini kiosk).
 *
 * The simplified sibling of the kiosk terminal: a grid of employee tiles that shows at a glance who is at the
 * workplace right now. Tapping a tile asks for the badge PIN of that employee and clocks them in or out, so several
 * people can use one device without signing in — exactly the “Anwesenheit” screen.
 *
 * It authenticates like the kiosk: with the **device token** of a terminal (`/presence?token=<device token>`), which
 * is remembered on the device, and it needs the `kioskEnabled` switch of the instance. Everything is decided on the
 * server; the screen only shows what the API answered.
 */

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { api, type TerminalPunchResult, type TerminalSessionResult, type TerminalUser } from "../api/client";
import { ErrorAlert } from "../components/feedback";

/** Where the device token of this device is remembered. */
const STORAGE_KEY = "zeiterfassung.presence";

/** How often the tiles are refreshed, so the screen also shows punches made elsewhere (milliseconds). */
const REFRESH_MILLISECONDS = 60_000;

/** How long the confirmation of a punch stays on the screen (milliseconds). */
const CONFIRMATION_MILLISECONDS = 8000;

/**
 * Reads the device token of this device: the URL wins, otherwise the remembered one.
 *
 * @returns the token or `null` when this device was never set up
 */
function readToken(): string | null {
	const fromUrl = new URLSearchParams(window.location.search).get("token");
	if (fromUrl?.trim()) {
		try {
			window.localStorage.setItem(STORAGE_KEY, fromUrl.trim());
		} catch {
			// a kiosk may forbid storage; the URL still carries the token for this session
		}
		return fromUrl.trim();
	}
	try {
		return window.localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

/**
 * Renders the presence screen.
 *
 * @returns the presence screen
 */
export function Presence(): React.JSX.Element {
	const { t } = useTranslation();
	const [token, setToken] = useState<string | null>(() => readToken());
	const [tokenInput, setTokenInput] = useState("");
	const [session, setSession] = useState<TerminalSessionResult | null>(null);
	const [users, setUsers] = useState<TerminalUser[]>([]);
	const [selected, setSelected] = useState<TerminalUser | null>(null);
	const [pin, setPin] = useState("");
	const [confirmation, setConfirmation] = useState<TerminalPunchResult | null>(null);
	const [problem, setProblem] = useState<unknown>(null);
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void (async () => {
			try {
				const status = await api.terminalStatus();
				setEnabled(status.enabled);
			} catch (error) {
				setProblem(error);
			}
		})();
	}, []);

	useEffect(() => {
		if (!token) {
			setSession(null);
			return;
		}
		void (async () => {
			try {
				const started = await api.terminalSession(token);
				setSession(started);
				setProblem(null);
			} catch (error) {
				setSession(null);
				setProblem(error);
			}
		})();
	}, [token]);

	/** Loads the employees together with their presence. */
	const loadUsers = useCallback(async (): Promise<void> => {
		if (!session) {
			return;
		}
		try {
			const answer = await api.terminalUsers(session.terminalSession);
			setUsers(answer.users);
			setProblem(null);
		} catch (error) {
			setProblem(error);
		}
	}, [session]);

	useEffect(() => {
		void loadUsers();
		// the tiles must also follow punches that happen somewhere else
		const timer = window.setInterval(() => void loadUsers(), REFRESH_MILLISECONDS);
		return () => window.clearInterval(timer);
	}, [loadUsers]);

	useEffect(() => {
		if (!confirmation) {
			return;
		}
		const timer = window.setTimeout(() => setConfirmation(null), CONFIRMATION_MILLISECONDS);
		return () => window.clearTimeout(timer);
	}, [confirmation]);

	/** Clocks the selected employee in or out. */
	const submit = useCallback(async (): Promise<void> => {
		if (!session || !selected || pin.length === 0) {
			return;
		}
		setBusy(true);
		try {
			const result = await api.terminalPunch({
				terminalSession: session.terminalSession,
				userId: selected.id,
				pin,
			});
			setConfirmation(result);
			// the answer carries the new state of the day, so the tile is right without asking again
			setUsers(current =>
				current.map(user =>
					user.id === result.user.id ? { ...user, present: result.day.hasOpenEntry } : user,
				),
			);
			setSelected(null);
			setPin("");
			setProblem(null);
		} catch (error) {
			setProblem(error);
		} finally {
			setBusy(false);
		}
	}, [pin, selected, session]);

	// this device is not set up yet: ask for the device token, the same flow as the kiosk terminal
	if (!token) {
		return (
			<Box sx={{ p: 2, maxWidth: 480, mx: "auto" }}>
				<Typography
					variant="h5"
					gutterBottom
				>
					{t("presence.title")}
				</Typography>
				<ErrorAlert error={problem} />
				<TextField
					label={t("terminal.deviceToken")}
					value={tokenInput}
					onChange={event => setTokenInput(event.target.value)}
					fullWidth
					sx={{ mt: 1 }}
				/>
				<Button
					variant="contained"
					size="large"
					sx={{ mt: 2 }}
					disabled={tokenInput.trim().length === 0}
					onClick={() => setToken(tokenInput.trim())}
				>
					{t("terminal.connect")}
				</Button>
			</Box>
		);
	}

	return (
		<Box sx={{ p: 2 }}>
			<Stack
				direction="row"
				justifyContent="space-between"
				alignItems="baseline"
				sx={{ mb: 2 }}
			>
				<Typography variant="h5">{t("presence.title")}</Typography>
				<Typography variant="body1">{session?.terminal.name ?? ""}</Typography>
			</Stack>

			{enabled === false && (
				<Alert
					severity="warning"
					sx={{ mb: 2 }}
				>
					{t("presence.disabled")}
				</Alert>
			)}
			<ErrorAlert error={problem} />

			{confirmation && (
				<Alert
					severity="success"
					sx={{ mb: 2 }}
				>
					{t("presence.updated", {
						name: confirmation.user.displayName,
						state: t(confirmation.day.hasOpenEntry ? "presence.present" : "presence.absent"),
					})}
				</Alert>
			)}

			<Box
				sx={{
					display: "grid",
					gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", md: "repeat(3, 1fr)" },
					gap: 2,
				}}
			>
				{users.map(user => (
					<Card
						key={user.id}
						variant="outlined"
						sx={{
							borderWidth: user.present ? 2 : 1,
							borderColor: user.present ? "success.main" : "divider",
							bgcolor: user.present ? "success.light" : "background.paper",
						}}
					>
						<CardActionArea
							onClick={() => {
								setSelected(user);
								setPin("");
							}}
						>
							<CardContent>
								<Stack
									direction="row"
									spacing={2}
									alignItems="center"
								>
									<Avatar sx={{ bgcolor: user.present ? "success.main" : "grey.500" }}>
										{initials(user.displayName)}
									</Avatar>
									<Box sx={{ minWidth: 0 }}>
										<Typography
											variant="subtitle1"
											noWrap
										>
											{user.displayName}
										</Typography>
										<Chip
											size="small"
											color={user.present ? "success" : "default"}
											label={t(user.present ? "presence.present" : "presence.absent")}
										/>
									</Box>
								</Stack>
							</CardContent>
						</CardActionArea>
					</Card>
				))}
			</Box>

			{selected && (
				<Card sx={{ mt: 2 }}>
					<CardContent>
						<Typography
							variant="h6"
							gutterBottom
						>
							{selected.displayName}
						</Typography>
						<Stack
							direction={{ xs: "column", sm: "row" }}
							spacing={2}
						>
							<TextField
								label={t("terminal.pin")}
								type="password"
								value={pin}
								onChange={event => setPin(event.target.value)}
								onKeyDown={event => {
									if (event.key === "Enter") {
										void submit();
									}
								}}
								helperText={t("presence.tapPin")}
								autoFocus
								fullWidth
							/>
							<Button
								variant="contained"
								size="large"
								disabled={busy || pin.length === 0}
								onClick={() => void submit()}
							>
								{t("punch.now")}
							</Button>
							<Button
								variant="text"
								size="large"
								onClick={() => {
									setSelected(null);
									setPin("");
								}}
							>
								{t("presence.cancel")}
							</Button>
						</Stack>
					</CardContent>
				</Card>
			)}
		</Box>
	);
}

/**
 * Builds the initials shown on a tile.
 *
 * @param displayName - name of the employee
 * @returns one or two letters
 */
function initials(displayName: string): string {
	const parts = displayName
		.trim()
		.split(/\s+/)
		.filter(part => part.length > 0);
	if (parts.length === 0) {
		return "?";
	}
	if (parts.length === 1) {
		return parts[0].slice(0, 2).toUpperCase();
	}
	return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}
