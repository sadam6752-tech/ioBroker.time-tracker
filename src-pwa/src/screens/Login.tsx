/**
 * Sign in screen.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorAlert } from "../components/feedback";
import { useBranding } from "../state/branding";
import { useSession } from "../state/session";

/**
 * Asks for user name and password.
 *
 * @returns the login screen
 */
export function Login(): React.JSX.Element {
	const { t } = useTranslation();
	const { signIn } = useSession();
	const branding = useBranding();
	const [login, setLogin] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);

	/**
	 * Signs in with the entered credentials.
	 *
	 * @param event - form event
	 */
	async function submit(event: FormEvent): Promise<void> {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await signIn(login.trim(), password);
		} catch (failure) {
			setError(failure);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", p: 2 }}>
			<Card sx={{ width: "100%", maxWidth: 420 }}>
				<CardContent>
					{branding.logoUrl && (
						<Box
							component="img"
							src={branding.logoUrl}
							alt=""
							sx={{ display: "block", maxHeight: 64, maxWidth: "100%", mb: 2 }}
						/>
					)}
					<Typography
						variant="h5"
						component="h1"
						gutterBottom
					>
						{t("app.title")}
					</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
						gutterBottom
					>
						{t("login.title")}
					</Typography>

					<Box
						component="form"
						onSubmit={event => void submit(event)}
						sx={{ mt: 2 }}
					>
						<Stack spacing={2}>
							<TextField
								label={t("login.login")}
								value={login}
								autoComplete="username"
								autoFocus
								required
								onChange={event => setLogin(event.target.value)}
							/>
							<TextField
								label={t("login.password")}
								type="password"
								value={password}
								autoComplete="current-password"
								required
								onChange={event => setPassword(event.target.value)}
							/>
							{busy ? <Alert severity="info">{t("login.failed")}</Alert> : <ErrorAlert error={error} />}
							<Button
								type="submit"
								variant="contained"
								size="large"
								disabled={busy}
							>
								{t("login.submit")}
							</Button>
						</Stack>
					</Box>
				</CardContent>
			</Card>
		</Box>
	);
}
