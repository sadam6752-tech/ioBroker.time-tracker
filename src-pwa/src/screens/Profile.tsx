/**
 * Profile: the signed in user, the language of the app and the password change.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ErrorAlert } from "../components/feedback";
import { SUPPORTED_LANGUAGES } from "../i18n";
import { useSession } from "../state/session";

/**
 * Shows the account and lets the user change the password.
 *
 * @returns the profile screen
 */
export function Profile(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { session, permissions } = useSession();
	const [password, setPassword] = useState("");
	const [changed, setChanged] = useState(false);
	const [error, setError] = useState<unknown>(null);

	/**
	 * Changes the own password.
	 *
	 * @param event - form event
	 */
	async function submit(event: FormEvent): Promise<void> {
		event.preventDefault();
		setError(null);
		try {
			await api.changePassword(password);
			setChanged(true);
			setPassword("");
		} catch (failure) {
			setError(failure);
		}
	}

	return (
		<AppShell title={t("profile.title")}>
			<Card sx={{ mb: 3 }}>
				<CardContent>
					<Stack spacing={1}>
						<Typography
							variant="body2"
							color="text.secondary"
						>
							{t("profile.user")}
						</Typography>
						<Typography variant="h6">{session?.user.displayName ?? session?.user.login}</Typography>
						<Typography
							variant="body2"
							color="text.secondary"
						>
							{session?.user.login} · {session?.user.timezone}
						</Typography>
						<TextField
							select
							label={t("profile.language")}
							size="small"
							value={i18n.language}
							onChange={event => void i18n.changeLanguage(event.target.value)}
							sx={{ maxWidth: 240, mt: 1 }}
						>
							{SUPPORTED_LANGUAGES.map(language => (
								<MenuItem
									key={language}
									value={language}
								>
									{language}
								</MenuItem>
							))}
						</TextField>
						<Box>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("profile.roles")}
							</Typography>
							<Typography variant="body2">{permissions.join(", ") || t("common.none")}</Typography>
						</Box>
					</Stack>
				</CardContent>
			</Card>

			<Card>
				<CardContent>
					<Typography
						variant="h6"
						gutterBottom
					>
						{t("profile.changePassword")}
					</Typography>
					{changed && <Alert severity="success">{t("profile.changed")}</Alert>}
					<ErrorAlert error={error} />
					<Box
						component="form"
						onSubmit={event => void submit(event)}
					>
						<Stack spacing={2}>
							<TextField
								label={t("profile.newPassword")}
								type="password"
								value={password}
								autoComplete="new-password"
								required
								size="small"
								onChange={event => setPassword(event.target.value)}
							/>
							<Button
								type="submit"
								variant="contained"
							>
								{t("profile.changePassword")}
							</Button>
						</Stack>
					</Box>
				</CardContent>
			</Card>
		</AppShell>
	);
}
