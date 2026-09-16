/**
 * Kiosk terminal screen.
 *
 * The screen has no user session: it authenticates with the **device token** of a terminal (created in the
 * administration), exchanges it for a short lived terminal session and then punches for the employee that scans
 * a badge or picks their name and enters the PIN. It is opened as `/terminal?token=<device token>`; the token is
 * remembered on the device, so a reload or a reboot of the kiosk does not need the URL again.
 *
 * Everything is decided on the server: the screen only shows what the API answered, and without the
 * `kioskEnabled` switch of the instance it refuses to work at all.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
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
import { useBranding } from "../state/branding";
import { Keypad } from "../components/Keypad";

/** Where the device token of this kiosk is remembered. */
const STORAGE_KEY = "zeiterfassung.terminal";

/** How long the confirmation of a punch stays on the screen (milliseconds). */
const RESULT_MILLISECONDS = 8000;

/** How often the screen tells the server that it is still there (milliseconds). */
const HEARTBEAT_MILLISECONDS = 5 * 60 * 1000;

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
 * Renders the kiosk terminal.
 *
 * @returns the terminal screen
 */
export function Terminal(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const [token, setToken] = useState<string | null>(() => readToken());
	const [tokenInput, setTokenInput] = useState("");
	const [session, setSession] = useState<TerminalSessionResult | null>(null);
	const [users, setUsers] = useState<TerminalUser[]>([]);
	const [selected, setSelected] = useState<TerminalUser | null>(null);
	const [badge, setBadge] = useState("");
	const [pin, setPin] = useState("");
	const [result, setResult] = useState<TerminalPunchResult | null>(null);
	const [problem, setProblem] = useState<unknown>(null);
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [timeZone, setTimeZone] = useState("UTC");
	const [clock, setClock] = useState(Math.floor(Date.now() / 1000));
	const offset = useRef(0);
	const branding = useBranding();

	/** Forgets the device token of this device. */
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
				setEnabled(false);
			}
		})();
	}, []);

	// the clock of the kiosk follows the server, not the device
	useEffect(() => {
		const timer = window.setInterval(() => setClock(Math.floor(Date.now() / 1000) + offset.current), 1000);
		return () => window.clearInterval(timer);
	}, []);

	// exchange the device token for a terminal session and load the employee list
	useEffect(() => {
		if (!token || enabled !== true) {
			return;
		}
		void (async () => {
			try {
				const started = await api.terminalSession(token);
				setSession(started);
				const list = await api.terminalUsers(started.terminalSession);
				setUsers(list.users);
			} catch (error) {
				setProblem(error);
				// an unknown or revoked token cannot be used any more, so the kiosk has to be set up again
				forgetToken();
			}
		})();
	}, [token, enabled, forgetToken]);

	// Keep the session alive. A kiosk browser throttles timers while the screen sleeps, so the heartbeat can be
	// late: when it fails, a new session is requested right away with the stored device token.
	useEffect(() => {
		if (!session || !token) {
			return;
		}
		const timer = window.setInterval(() => {
			void api.terminalHeartbeat(session.terminalSession).catch(async () => {
				try {
					setSession(await renewTerminalSession(token));
				} catch {
					// the device token itself is not usable any more: the kiosk has to be set up again
					forgetToken();
				}
			});
		}, HEARTBEAT_MILLISECONDS);
		return () => window.clearInterval(timer);
	}, [session, token, forgetToken]);

	/** Sends a punch and shows the confirmation for a moment. */
	const punch = useCallback(
		async (input: { badge?: string; userId?: number; pin?: string }): Promise<void> => {
			if (!session || !token) {
				return;
			}
			setProblem(null);
			try {
				const done = await withFreshSession({
					deviceToken: token,
					session,
					call: current => api.terminalPunch({ terminalSession: current.terminalSession, ...input }),
					onRenewed: setSession,
				});
				setResult(done);
				setSelected(null);
				setBadge("");
				setPin("");
				window.setTimeout(() => setResult(null), RESULT_MILLISECONDS);
			} catch (error) {
				setProblem(error);
			}
		},
		[session, token],
	);

	if (enabled === null) {
		return (
			<Box sx={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center" }}>
				<Typography>{t("common.loading")}</Typography>
			</Box>
		);
	}

	if (enabled !== true) {
		return (
			<Box sx={{ p: 3 }}>
				<Alert severity="warning">{t("terminal.disabled")}</Alert>
				<ErrorAlert error={problem} />
			</Box>
		);
	}

	if (!token) {
		return (
			<Box sx={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", p: 2 }}>
				<Card sx={{ maxWidth: 480, width: "100%" }}>
					<CardContent>
						<Typography
							variant="h6"
							gutterBottom
						>
							{t("terminal.title")}
						</Typography>
						<Stack spacing={2}>
							<TextField
								label={t("terminal.deviceToken")}
								value={tokenInput}
								onChange={event => setTokenInput(event.target.value)}
								fullWidth
								autoFocus
							/>
							<ErrorAlert error={problem} />
							<Button
								variant="contained"
								disabled={tokenInput.trim().length === 0}
								onClick={() => setToken(tokenInput.trim())}
							>
								{t("terminal.connect")}
							</Button>
						</Stack>
					</CardContent>
				</Card>
			</Box>
		);
	}

	if (!session) {
		return (
			<Box sx={{ p: 3 }}>
				<Typography>{t("common.loading")}</Typography>
				<ErrorAlert error={problem} />
			</Box>
		);
	}

	if (result) {
		return (
			<Box sx={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", p: 2 }}>
				<Card sx={{ maxWidth: 560, width: "100%" }}>
					<CardContent>
						<Typography
							variant="h4"
							gutterBottom
						>
							{result.user.displayName}
						</Typography>
						<Alert severity="success">
							{`${t(result.entry.direction === "out" ? "punch.out" : "punch.in")} — ${t("punch.sent", {
								time: formatTime(result.entry.tsUtc, timeZone, i18n.language),
							})}`}
						</Alert>
						<Stack
							spacing={0.5}
							sx={{ mt: 2 }}
						>
							<Typography variant="body1">
								{t("punch.worked")}: {result.day.workedMin} min
							</Typography>
							<Typography variant="body1">
								{t("punch.target")}: {result.day.targetMin} min
							</Typography>
							<Typography variant="body1">
								{t("punch.balance")}: {result.day.balanceMin} min
							</Typography>
							{!result.day.hasOpenEntry && (
								<Typography
									variant="body2"
									color="text.secondary"
								>
									{t("punch.closed")}
								</Typography>
							)}
						</Stack>
					</CardContent>
				</Card>
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
					sx={{ alignItems: "center", minWidth: 0 }}
				>
					{branding.logoUrl && (
						<Box
							component="img"
							src={branding.logoUrl}
							alt=""
							sx={{ height: 28, maxWidth: 120, objectFit: "contain" }}
						/>
					)}
					<Typography variant="h5">{session.terminal.name}</Typography>
				</Stack>
				<Typography variant="h5">{formatTime(clock, timeZone, i18n.language)}</Typography>
			</Stack>

			<ErrorAlert error={problem} />

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Stack
						direction={{ xs: "column", sm: "row" }}
						spacing={2}
					>
						<TextField
							label={t("terminal.badge")}
							value={badge}
							onChange={event => setBadge(event.target.value)}
							onKeyDown={event => {
								if (event.key === "Enter" && badge.trim()) {
									void punch({ badge: badge.trim() });
								}
							}}
							autoFocus
							fullWidth
						/>
						<Button
							variant="contained"
							size="large"
							disabled={badge.trim().length === 0}
							onClick={() => void punch({ badge: badge.trim() })}
						>
							{t("punch.now")}
						</Button>
					</Stack>
					{/* the card number is punched in on touch screens as well */}
					<Keypad
						onDigit={digit => setBadge(current => current + digit)}
						onBackspace={() => setBadge(current => current.slice(0, -1))}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("terminal.select")}
					</Typography>
					<Stack
						direction="row"
						spacing={1}
						sx={{ flexWrap: "wrap", gap: 1 }}
					>
						{users.map(user => (
							<Button
								key={user.id}
								variant={selected?.id === user.id ? "contained" : "outlined"}
								startIcon={
									<Avatar
										// the stored picture, or the placeholder of the project when none is set
										src={user.avatarUrl ?? "/person.png"}
										alt=""
										sx={{ width: 24, height: 24 }}
									/>
								}
								onClick={() => setSelected(user)}
							>
								{user.displayName}
							</Button>
						))}
					</Stack>

					<Stack
						direction={{ xs: "column", sm: "row" }}
						spacing={2}
						sx={{ mt: 2 }}
					>
						<TextField
							label={t("terminal.pin")}
							type="password"
							value={pin}
							onChange={event => setPin(event.target.value)}
							helperText={t("admin.user.pinHint")}
							fullWidth
						/>
						<Button
							variant="contained"
							size="large"
							disabled={!selected || pin.length === 0}
							onClick={() => selected && void punch({ userId: selected.id, pin })}
						>
							{t("punch.now")}
						</Button>
					</Stack>
					{/* the PIN is entered on the pad as well, so a kiosk without a keyboard works */}
					<Keypad
						onDigit={digit => setPin(current => current + digit)}
						onBackspace={() => setPin(current => current.slice(0, -1))}
					/>
				</CardContent>
			</Card>
		</Box>
	);
}
