/**
 * Administration: BackupTab (split out of `Admin.tsx`).
 */

import Alert from "@mui/material/Alert";
import BackupIcon from "@mui/icons-material/Backup";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import DeleteIcon from "@mui/icons-material/Delete";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import DownloadIcon from "@mui/icons-material/Download";
import { ErrorAlert, Loading } from "../../components/feedback";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import RestoreIcon from "@mui/icons-material/Restore";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { api } from "../../api/client";
import { saveBlob } from "../../components/ReportDownloads";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatSize, formatStamp } from "./helpers";

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
export function BackupTab({ language }: { language: string }): React.JSX.Element {
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
