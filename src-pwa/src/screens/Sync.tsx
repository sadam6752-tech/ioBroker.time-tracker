/**
 * Synchronisation screen: queued punches and open conflicts.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatTime } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ErrorAlert } from "../components/feedback";
import { useSync } from "../offline/useSync";
import { hasPermission, useSession } from "../state/session";

/**
 * Shows the offline queue and lets the user send and resolve it.
 *
 * @returns the sync screen
 */
export function Sync(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { session, permissions } = useSession();
	const { pending, flush, busy, outcome } = useSync();
	const queryClient = useQueryClient();
	const timeZone = session?.user.timezone ?? "UTC";
	const mayResolve = hasPermission(permissions, "time.resolve_conflict");

	const conflicts = useQuery({
		queryKey: ["conflicts"],
		queryFn: () => api.conflicts(),
		enabled: mayResolve,
		retry: false,
	});

	const resolve = useMutation({
		mutationFn: (input: { entryId: number; action: "accept" | "dismiss" }) =>
			api.resolve(input.entryId, input.action),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["conflicts"] }),
	});

	return (
		<AppShell title={t("sync.title")}>
			<Card sx={{ mb: 3 }}>
				<CardContent>
					<Typography
						variant="h6"
						gutterBottom
					>
						{pending.length > 0 ? t("sync.pending", { count: pending.length }) : t("sync.none")}
					</Typography>
					{outcome && (
						<Alert
							severity="success"
							sx={{ mt: 1 }}
						>
							{t("sync.done", {
								accepted: outcome.accepted,
								duplicates: outcome.duplicates,
								conflicts: outcome.conflicts,
							})}
						</Alert>
					)}
					<Stack
						spacing={2}
						sx={{ mt: 2 }}
					>
						<Button
							variant="contained"
							disabled={busy || pending.length === 0}
							onClick={() => void flush()}
						>
							{t("sync.flush")}
						</Button>
					</Stack>

					{pending.length > 0 && (
						<List dense>
							{pending.map(entry => (
								<ListItem key={entry.idempotencyKey}>
									<ListItemText
										primary={formatTime(entry.tsUtc, timeZone, i18n.language)}
										secondary={entry.note ?? undefined}
									/>
								</ListItem>
							))}
						</List>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardContent>
					<Typography
						variant="h6"
						gutterBottom
					>
						{t("sync.conflicts")}
					</Typography>

					{!mayResolve ? (
						<Alert severity="info">{t("sync.permission")}</Alert>
					) : (
						<>
							<ErrorAlert error={conflicts.error} />
							{resolve.error && <ErrorAlert error={resolve.error} />}
							{(conflicts.data ?? []).length === 0 ? (
								<Box>
									<Typography
										variant="body2"
										color="text.secondary"
									>
										{t("sync.empty")}
									</Typography>
								</Box>
							) : (
								<List dense>
									{(conflicts.data ?? []).map(conflict => (
										<ListItem
											key={conflict.id}
											secondaryAction={
												<Stack
													direction="row"
													spacing={1}
												>
													<Button
														size="small"
														onClick={() =>
															resolve.mutate({
																entryId: conflict.entryId ?? conflict.id,
																action: "accept",
															})
														}
													>
														{t("sync.accept")}
													</Button>
													<Button
														size="small"
														color="warning"
														onClick={() =>
															resolve.mutate({
																entryId: conflict.entryId ?? conflict.id,
																action: "dismiss",
															})
														}
													>
														{t("sync.dismiss")}
													</Button>
												</Stack>
											}
										>
											<ListItemText
												primary={t("sync.conflictOf", {
													date: conflict.localDate,
													time: formatTime(conflict.tsUtc, timeZone, i18n.language),
												})}
												secondary={conflict.note ?? undefined}
											/>
										</ListItem>
									))}
								</List>
							)}
						</>
					)}
				</CardContent>
			</Card>
		</AppShell>
	);
}
