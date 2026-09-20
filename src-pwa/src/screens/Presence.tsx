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

import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useTranslation } from "react-i18next";
import {
	api,
	formatTime,
	type TerminalPunchResult,
	type TerminalSessionResult,
	type TerminalUser,
} from "../api/client";
import { renewTerminalSession, withFreshSession } from "../api/terminal-session";
import { ErrorAlert } from "../components/feedback";
import { Keypad } from "../components/Keypad";
import { useBranding } from "../state/branding";

/** Where the device token of this device is remembered. */
const STORAGE_KEY = "time-tracker.presence";

/** How often the tiles are refreshed, so the screen also shows punches made elsewhere (milliseconds). */
const REFRESH_MILLISECONDS = 60_000;

/** How often the device tells the server that it is still there (milliseconds; the session lives 15 minutes). */
const HEARTBEAT_MILLISECONDS = 5 * 60 * 1000;

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
	const { t, i18n } = useTranslation();
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
	const [timeZone, setTimeZone] = useState("UTC");
	const [clock, setClock] = useState(Math.floor(Date.now() / 1000));
	const offset = useRef(0);
	const branding = useBranding();

	/** Forgets the device token of this device, so the screen asks for a new one. */
	const forgetToken = useCallback((): void => {
		try {
			window.localStorage.removeItem(STORAGE_KEY);
		} catch {
			// nothing to clean up
		}
		setToken(null);
	}, []);

	useEffect(() => {
		void (async () => {
			try {
				const status = await api.terminalStatus();
				setEnabled(status.enabled);
				setTimeZone(status.timezone);
				offset.current = status.serverTime - Math.floor(Date.now() / 1000);
			} catch (error) {
				setProblem(error);
			}
		})();
	}, []);

	// the clock follows the server, not the device — the same way the kiosk terminal does it
	useEffect(() => {
		const timer = window.setInterval(() => setClock(Math.floor(Date.now() / 1000) + offset.current), 1000);
		return () => window.clearInterval(timer);
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

	/** Loads the employees together with their presence; renews the session when it expired. */
	const loadUsers = useCallback(async (): Promise<void> => {
		if (!session || !token) {
			return;
		}
		try {
			const answer = await withFreshSession({
				deviceToken: token,
				session,
				call: current => api.terminalUsers(current.terminalSession),
				onRenewed: setSession,
			});
			setUsers(answer.users);
			setProblem(null);
		} catch (error) {
			setProblem(error);
		}
	}, [session, token]);

	useEffect(() => {
		void loadUsers();
		// the tiles must also follow punches that happen somewhere else
		const timer = window.setInterval(() => void loadUsers(), REFRESH_MILLISECONDS);
		return () => window.clearInterval(timer);
	}, [loadUsers]);

	// Keep the session alive. A browser in the workshop throttles timers and may sleep for a long time, so the
	// heartbeat alone is not enough — when it fails, a new session is requested right away with the device token.
	useEffect(() => {
		if (!session || !token) {
			return;
		}
		const timer = window.setInterval(() => {
			void api.terminalHeartbeat(session.terminalSession).catch(async () => {
				try {
					setSession(await renewTerminalSession(token));
				} catch (error) {
					// the device token itself is not usable any more: the screen has to be set up again
					setProblem(error);
					forgetToken();
				}
			});
		}, HEARTBEAT_MILLISECONDS);
		return () => window.clearInterval(timer);
	}, [session, token, forgetToken]);

	useEffect(() => {
		if (!confirmation) {
			return;
		}
		const timer = window.setTimeout(() => setConfirmation(null), CONFIRMATION_MILLISECONDS);
		return () => window.clearTimeout(timer);
	}, [confirmation]);

	/** Clocks the selected employee in or out. */
	const submit = useCallback(async (): Promise<void> => {
		// a device without the PIN duty does not need one at all
		const pinRequired = session?.terminal.pinRequired === true;
		if (!session || !token || !selected || (pinRequired && pin.length === 0)) {
			return;
		}
		setBusy(true);
		try {
			const result = await withFreshSession({
				deviceToken: token,
				session,
				call: current =>
					api.terminalPunch({
						terminalSession: current.terminalSession,
						userId: selected.id,
						// never send an empty PIN: a present but wrong value would be refused
						...(pin ? { pin } : {}),
					}),
				onRenewed: setSession,
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
	}, [pin, selected, session, token]);

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
				<Stack
					direction="row"
					spacing={1}
					sx={{ alignItems: "center" }}
				>
					{branding.logoUrl && (
						<Box
							component="img"
							src={branding.logoUrl}
							alt=""
							sx={{ height: 28, maxWidth: 120, objectFit: "contain" }}
						/>
					)}
					<Typography variant="h5">{t("presence.title")}</Typography>
				</Stack>
				<Stack
					direction="row"
					spacing={1}
					alignItems="center"
				>
					<Typography variant="h5">{formatTime(clock, timeZone, i18n.language)}</Typography>
					<Typography variant="body1">{session?.terminal.name ?? ""}</Typography>
					<IconButton
						size="small"
						title={t("common.refresh")}
						aria-label={t("common.refresh")}
						onClick={() => void loadUsers()}
					>
						<RefreshIcon fontSize="small" />
					</IconButton>
				</Stack>
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
					// the tiles size themselves from their content: a wide screen gets more of them side by side
					// instead of three stretched ones
					gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
					gap: 1.5,
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
							{/* deliberately flat: one line of text next to a bigger picture, so a screen full of
							    tiles stays readable at a glance */}
							<Stack
								direction="row"
								spacing={1.5}
								alignItems="center"
								sx={{ px: 1.5, py: 0.5 }}
							>
								<Avatar
									// the stored picture, or the placeholder of the project when none is set
									src={user.avatarUrl ?? "/person.png"}
									sx={{ width: 56, height: 56, bgcolor: user.present ? "success.main" : "grey.500" }}
								>
									{initials(user.displayName)}
								</Avatar>
								{/* the state above the name: both lines then have the whole width of the tile */}
								<Box sx={{ minWidth: 0, flexGrow: 1 }}>
									<Chip
										size="small"
										color={user.present ? "success" : "default"}
										label={t(user.present ? "presence.present" : "presence.absent")}
									/>
									<Typography
										variant="subtitle1"
										noWrap
										sx={{ lineHeight: 1.3 }}
									>
										{user.displayName}
									</Typography>
								</Box>
							</Stack>
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
							{session?.terminal.pinRequired === false ? (
								<Typography
									variant="body2"
									color="text.secondary"
									sx={{ alignSelf: "center" }}
								>
									{t("terminal.noPin")}
								</Typography>
							) : (
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
							)}
							{session?.terminal.pinRequired === false ? null : (
								<Keypad
									onDigit={digit => setPin(current => current + digit)}
									onBackspace={() => setPin(current => current.slice(0, -1))}
									disabled={busy}
								/>
							)}
							<Button
								variant="contained"
								size="large"
								disabled={busy || (session?.terminal.pinRequired === true && pin.length === 0)}
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
