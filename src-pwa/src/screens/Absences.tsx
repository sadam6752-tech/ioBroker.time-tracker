/**
 * Absences: the list of a year and a simple request form.
 */

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDate } from "../api/client";
import { AppShell } from "../components/AppShell";
import { ActionRow } from "../components/ActionRow";
import { ErrorAlert, Loading } from "../components/feedback";
import { hasPermission, useSession } from "../state/session";

/**
 * Shows and requests absences.
 *
 * @returns the absence screen
 */
export function Absences(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { permissions } = useSession();
	const queryClient = useQueryClient();
	const [year, setYear] = useState(() => new Date().getFullYear());
	const [typeCode, setTypeCode] = useState("");
	const [dateFrom, setDateFrom] = useState("");
	const [dateTo, setDateTo] = useState("");
	const [created, setCreated] = useState(false);

	const mayRequest = hasPermission(permissions, "absence.request");
	const list = useQuery({ queryKey: ["absences", year], queryFn: () => api.absences(year) });
	const types = useQuery({
		queryKey: ["absence-types"],
		queryFn: () => api.absenceTypes(),
		enabled: mayRequest,
		staleTime: 5 * 60_000,
	});
	const availableTypes = types.data ?? [];

	const create = useMutation({
		mutationFn: () =>
			api.createAbsence({
				typeCode: typeCode.trim(),
				dateFrom,
				...(dateTo ? { dateTo } : {}),
			}),
		onSuccess: () => {
			setTypeCode("");
			setDateFrom("");
			setDateTo("");
			setCreated(true);
			void queryClient.invalidateQueries({ queryKey: ["absences", year] });
		},
	});

	/**
	 * Sends the form.
	 *
	 * @param event - form event
	 */
	function submit(event: FormEvent): void {
		event.preventDefault();
		setCreated(false);
		create.mutate();
	}

	return (
		<AppShell title={t("absences.title")}>
			<Card sx={{ mb: 2 }}>
				<Stack
					direction="row"
					alignItems="center"
					justifyContent="space-between"
					sx={{ p: 1 }}
				>
					<IconButton
						onClick={() => setYear(value => value - 1)}
						title={t("month.previous")}
					>
						<ChevronLeftIcon />
					</IconButton>
					<Typography variant="h6">{year}</Typography>
					<IconButton
						onClick={() => setYear(value => value + 1)}
						title={t("month.next")}
					>
						<ChevronRightIcon />
					</IconButton>
				</Stack>
			</Card>

			<ErrorAlert error={list.error} />
			{list.isLoading ? (
				<Loading />
			) : (
				<Card sx={{ mb: 3 }}>
					<List dense>
						{(list.data ?? []).map(absence => (
							<ActionRow
								key={absence.id}
								primary={`${absence.typeCode}: ${formatDate(absence.dateFrom, i18n.language)}${
									absence.dateTo && absence.dateTo !== absence.dateFrom
										? ` – ${formatDate(absence.dateTo, i18n.language)}`
										: ""
								}`}
								secondary={`${t("absences.portion")}: ${absence.dayPortion}`}
							>
								<Typography
									variant="body2"
									color="text.secondary"
								>
									{absence.status}
								</Typography>
							</ActionRow>
						))}
					</List>
					{(list.data ?? []).length === 0 && (
						<Box sx={{ p: 2 }}>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("absences.empty")}
							</Typography>
						</Box>
					)}
				</Card>
			)}

			{mayRequest && (
				<Card>
					<CardContent>
						<Typography
							variant="h6"
							gutterBottom
						>
							{t("absences.create")}
						</Typography>
						{created && <Alert severity="success">{t("absences.created")}</Alert>}
						<ErrorAlert error={create.error} />
						<Box
							component="form"
							onSubmit={submit}
						>
							<Stack spacing={2}>
								{availableTypes.length > 0 ? (
									<TextField
										select
										label={t("absences.type")}
										value={typeCode}
										required
										size="small"
										onChange={event => setTypeCode(event.target.value)}
									>
										{availableTypes.map(type => (
											<MenuItem
												key={type.id}
												value={type.code}
											>
												{type.code} – {type.name}
											</MenuItem>
										))}
									</TextField>
								) : (
									<TextField
										label={t("absences.type")}
										value={typeCode}
										required
										size="small"
										helperText={t("absences.typeHint")}
										onChange={event => setTypeCode(event.target.value)}
									/>
								)}
								<TextField
									label={t("absences.from")}
									type="date"
									value={dateFrom}
									required
									size="small"
									InputLabelProps={{ shrink: true }}
									onChange={event => setDateFrom(event.target.value)}
								/>
								<TextField
									label={t("absences.to")}
									type="date"
									value={dateTo}
									size="small"
									InputLabelProps={{ shrink: true }}
									onChange={event => setDateTo(event.target.value)}
								/>
								<Button
									type="submit"
									variant="contained"
									disabled={create.isPending}
								>
									{t("common.save")}
								</Button>
							</Stack>
						</Box>
					</CardContent>
				</Card>
			)}
		</AppShell>
	);
}
