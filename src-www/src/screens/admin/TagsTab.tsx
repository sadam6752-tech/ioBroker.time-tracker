/**
 * Administration: TagDialog, TagsTab (split out of `Admin.tsx`).
 */

import { ActionRow } from "../../components/ActionRow";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import { ErrorAlert } from "../../components/feedback";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import QRCode from "qrcode";
import { type RfidTagRecord, api } from "../../api/client";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatStamp } from "./helpers";

/**
 * Edits a badge: employee, label and validity.
 *
 * The link signs the owner and the expiry, so a different employee or a new validity issues a new link — the answer
 * carries it, and everything handed out before stops working. A label on its own leaves the link alone.
 *
 * @param props - badge to edit, close handler and success handler
 * @param props.tag - badge to edit
 * @param props.onClose - called when the dialog is closed
 * @param props.onSaved - called with the answer of the server after a successful change
 * @returns the dialog
 */
function TagDialog({
	tag,
	onClose,
	onSaved,
}: {
	tag: RfidTagRecord;
	onClose: () => void;
	onSaved: (saved: { tag: RfidTagRecord; token?: string; url?: string }) => Promise<void>;
}): React.JSX.Element {
	const { t } = useTranslation();
	const people = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users() });
	const [userId, setUserId] = useState(tag.userId === null ? "" : String(tag.userId));
	const [label, setLabel] = useState(tag.label ?? "");
	const [ttlDays, setTtlDays] = useState("");

	const days = ttlDays.trim() === "" ? undefined : Number(ttlDays);
	const invalid = !userId || (days !== undefined && (!Number.isInteger(days) || days <= 0));

	const save = useMutation({
		mutationFn: () =>
			api.updateTag(tag.id, {
				userId: Number(userId),
				// an empty field clears the label, that is what the server understands as `null`
				label: label.trim() ? label.trim() : null,
				...(days === undefined ? {} : { ttlDays: days }),
			}),
		onSuccess: onSaved,
	});

	// a new link for a badge that was lost, expired or revoked — the link handed out before stops working
	const reissue = useMutation({
		mutationFn: () => api.reissueTagLink(tag.id),
		onSuccess: onSaved,
	});

	return (
		<Dialog
			open
			onClose={onClose}
			fullWidth
		>
			<DialogTitle>{`${t("admin.tag.editTitle")} · ${tag.label ?? tag.uid}`}</DialogTitle>
			<DialogContent>
				<Stack
					spacing={2}
					sx={{ mt: 1 }}
				>
					<Typography
						variant="body2"
						color="text.secondary"
					>
						{t("admin.tag.editHint")}
					</Typography>
					<TextField
						select
						label={t("admin.tag.user")}
						value={userId}
						onChange={event => setUserId(event.target.value)}
					>
						{(people.data ?? []).map(user => (
							<MenuItem
								key={user.id}
								value={String(user.id)}
							>
								{`${user.displayName} (${user.login})`}
							</MenuItem>
						))}
					</TextField>
					<TextField
						label={t("admin.tag.label")}
						value={label}
						onChange={event => setLabel(event.target.value)}
					/>
					<TextField
						label={t("admin.tag.validityDays")}
						type="number"
						value={ttlDays}
						onChange={event => setTtlDays(event.target.value)}
					/>
					<ErrorAlert error={people.error ?? save.error ?? reissue.error} />
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button
					onClick={() => reissue.mutate()}
					disabled={reissue.isPending}
					sx={{ mr: "auto" }}
				>
					{t("admin.tag.reissue")}
				</Button>
				<Button onClick={onClose}>{t("common.cancel")}</Button>
				<Button
					variant="contained"
					disabled={invalid || save.isPending}
					onClick={() => save.mutate()}
				>
					{t("common.save")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}

/**
 * Badges of the employees: create a signed link for a tag, list and remove them.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the badge tab
 */
export function TagsTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const tags = useQuery({ queryKey: ["admin", "tags"], queryFn: () => api.rfidTags() });
	const people = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users() });
	const [userId, setUserId] = useState("");
	const [label, setLabel] = useState("");
	const [issued, setIssued] = useState<{ token: string; url: string; reissued: boolean } | null>(null);
	const [qr, setQr] = useState<string | null>(null);
	const [editing, setEditing] = useState<RfidTagRecord | null>(null);

	/** Refreshes the list of the badges. */
	const reload = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["admin", "tags"] });
	};

	/**
	 * Builds the link from the address this administration is reached with — scheme, host and port come from the
	 * browser, so it works on plain HTTP and behind a reverse proxy alike and no server side guess can point at a
	 * scheme the instance does not serve.
	 *
	 * @param token - signed token of the badge
	 * @returns the link to write onto the badge
	 */
	const linkFor = (token: string): string => `${window.location.origin}/?tag=${token}`;

	/**
	 * Shows the link of a badge that was just created or given a new one.
	 *
	 * @param token - signed token of the badge
	 * @param reissued - true when the badge had a link before, which is dead now
	 */
	const showLink = (token: string, reissued: boolean): void => {
		setIssued({ token, url: linkFor(token), reissued });
	};

	// The code is drawn in the browser: it works offline and no service sees the link.
	useEffect(() => {
		if (!issued) {
			setQr(null);
			return undefined;
		}
		let cancelled = false;
		QRCode.toDataURL(issued.url, { margin: 1, width: 240 })
			.then(dataUrl => {
				if (!cancelled) {
					setQr(dataUrl);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setQr(null);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [issued]);

	const create = useMutation({
		mutationFn: () => api.createTag({ userId: Number(userId), ...(label.trim() ? { label: label.trim() } : {}) }),
		onSuccess: async created => {
			showLink(created.token, false);
			setLabel("");
			await reload();
		},
	});

	const remove = useMutation({
		mutationFn: (id: number) => api.deleteTag(id),
		onSuccess: reload,
	});

	// a badge that was revoked can be taken out of the list for good
	const purge = useMutation({
		mutationFn: (id: number) => api.deleteTagPermanently(id),
		onSuccess: reload,
	});

	/**
	 * Name of the employee a badge belongs to.
	 *
	 * @param id - user id
	 * @returns shown name
	 */
	const nameOf = (id: number): string => (people.data ?? []).find(user => user.id === id)?.displayName ?? `#${id}`;

	return (
		<>
			<ErrorAlert error={tags.error ?? create.error ?? remove.error ?? purge.error} />

			{issued && (
				<Alert
					severity="success"
					sx={{ mb: 2 }}
				>
					<Typography
						variant="body2"
						gutterBottom
					>
						{t("admin.tag.linkOnce")}
					</Typography>
					<Typography
						variant="body2"
						sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
					>
						{issued.url}
					</Typography>
					{qr && (
						<Box sx={{ mt: 1.5 }}>
							<img
								src={qr}
								alt={t("admin.tag.qrAlt")}
								width={200}
								height={200}
								style={{ display: "block", borderRadius: 4 }}
							/>
						</Box>
					)}
					{issued.reissued && (
						<Typography
							variant="body2"
							sx={{ mt: 1 }}
						>
							{t("admin.tag.oldLinkDead")}
						</Typography>
					)}
				</Alert>
			)}

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Stack
						direction={{ xs: "column", sm: "row" }}
						spacing={2}
						sx={{ mt: 1 }}
					>
						<TextField
							select
							label={t("admin.tag.user")}
							value={userId}
							onChange={event => setUserId(event.target.value)}
							sx={{ minWidth: 220 }}
						>
							{(people.data ?? []).map(user => (
								<MenuItem
									key={user.id}
									value={String(user.id)}
								>
									{`${user.displayName} (${user.login})`}
								</MenuItem>
							))}
						</TextField>
						<TextField
							label={t("admin.tag.label")}
							value={label}
							onChange={event => setLabel(event.target.value)}
							fullWidth
						/>
						<Button
							variant="contained"
							disabled={!userId || create.isPending}
							onClick={() => create.mutate()}
						>
							{t("admin.tag.create")}
						</Button>
					</Stack>
				</CardContent>
			</Card>

			<Card>
				<List dense>
					{(tags.data ?? []).map(tag => {
						const expired = tag.expiresAt !== null && tag.expiresAt * 1000 < Date.now();
						const state =
							tag.isActive === false
								? t("admin.tag.revoked")
								: expired
									? t("admin.tag.expired")
									: t("admin.tag.active");
						const until = tag.expiresAt ? formatStamp(tag.expiresAt, language) : t("common.none");
						const used = tag.lastUsedAt ? formatStamp(tag.lastUsedAt, language) : t("common.none");
						return (
							<ActionRow
								key={tag.id}
								primary={`${tag.label ?? tag.uid ?? `#${tag.id}`} · ${nameOf(tag.userId)}`}
								secondary={`${state} · ${t("admin.tag.lastUsed")}: ${used} · ${tag.uid ?? t("common.none")} · ${until}`}
							>
								<Button
									size="small"
									onClick={() => setEditing(tag)}
								>
									{t("admin.tag.edit")}
								</Button>
								{tag.isActive !== false && (
									<Button
										size="small"
										color="error"
										onClick={() => remove.mutate(tag.id)}
									>
										{t("admin.tag.delete")}
									</Button>
								)}
								{tag.isActive === false && (
									<Button
										size="small"
										color="error"
										onClick={() => purge.mutate(tag.id)}
									>
										{t("admin.tag.remove")}
									</Button>
								)}
							</ActionRow>
						);
					})}
					{!tags.isLoading && (tags.data ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("admin.tag.empty")} />
						</ListItem>
					)}
				</List>
			</Card>

			{editing && (
				<TagDialog
					tag={editing}
					onClose={() => setEditing(null)}
					onSaved={async saved => {
						setEditing(null);
						// a new employee or a new validity answers with a new link: show it like a fresh badge
						if (saved.token) {
							showLink(saved.token, true);
						}
						await reload();
					}}
				/>
			)}
		</>
	);
}
