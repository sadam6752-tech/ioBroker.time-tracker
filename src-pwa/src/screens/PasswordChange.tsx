/**
 * Screen that forces a new password.
 *
 * It is shown for every route while `mustChangePw` is set: the start password of the first administrator and
 * passwords imported from the old system open the door exactly once (specification 2.9.1).
 */

import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { ErrorAlert } from "../components/feedback";
import { useSession } from "../state/session";

/**
 * Asks for a new password and ends the session afterwards.
 *
 * @returns the password change screen
 */
export function PasswordChange(): React.JSX.Element {
	const { t } = useTranslation();
	const { session, signOut } = useSession();
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<unknown>(null);
	const [done, setDone] = useState(false);

	/** Stores the new password; the server revokes every session of the account with it. */
	async function submit(): Promise<void> {
		setBusy(true);
		setProblem(null);
		try {
			await api.changePassword(password);
			setDone(true);
			try {
				await signOut();
			} catch {
				// the session is invalid already; the login screen appears anyway
			}
		} catch (error) {
			setProblem(error);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", p: 2 }}>
			<Card sx={{ maxWidth: 420, width: "100%" }}>
				<CardContent>
					<Typography
						variant="h6"
						gutterBottom
					>
						{t("profile.changePassword")}
					</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
						gutterBottom
					>
						{session?.user.login}
					</Typography>
					{done ? (
						<Alert severity="success">{t("profile.changed")}</Alert>
					) : (
						<Stack
							spacing={2}
							sx={{ mt: 1 }}
						>
							<TextField
								type="password"
								label={t("profile.newPassword")}
								helperText={t("admin.user.passwordHint")}
								value={password}
								onChange={event => setPassword(event.target.value)}
								autoComplete="new-password"
								fullWidth
							/>
							<ErrorAlert error={problem} />
							<Button
								variant="contained"
								disabled={busy || password.length === 0}
								onClick={() => void submit()}
							>
								{t("profile.changePassword")}
							</Button>
						</Stack>
					)}
				</CardContent>
			</Card>
		</Box>
	);
}
