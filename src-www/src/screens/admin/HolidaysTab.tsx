/**
 * Administration: HolidaysTab (split out of `Admin.tsx`).
 */

import { ActionRow } from "../../components/ActionRow";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import { ErrorAlert } from "../../components/feedback";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { api, formatDate } from "../../api/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Public holidays of a year: list, add and remove.
 *
 * @param props - language of the display
 * @param props.language - language of the display
 * @returns the holiday tab
 */
export function HolidaysTab({ language }: { language: string }): React.JSX.Element {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [year, setYear] = useState(String(new Date().getFullYear()));
	const [date, setDate] = useState("");
	const [name, setName] = useState("");
	const [region, setRegion] = useState("");

	const holidays = useQuery({
		queryKey: ["admin", "holidays", year],
		queryFn: () => api.holidays(Number(year)),
	});

	/** Refreshes the list of the shown year. */
	const reload = async (): Promise<void> => {
		await queryClient.invalidateQueries({ queryKey: ["admin", "holidays", year] });
	};

	const add = useMutation({
		mutationFn: () =>
			api.createHoliday({
				date: date.trim(),
				name: name.trim(),
				...(region.trim() ? { region: region.trim() } : {}),
			}),
		onSuccess: async () => {
			// the list shows one year; a holiday of another one would be saved and missing from it right away
			const addedYear = date.trim().slice(0, 4);
			setDate("");
			setName("");
			setRegion("");
			if (addedYear !== year) {
				setYear(addedYear);
			}
			await reload();
		},
	});

	const remove = useMutation({
		mutationFn: (id: number) => api.deleteHoliday(id),
		onSuccess: reload,
	});

	const ready = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) && name.trim().length > 0;

	return (
		<>
			<ErrorAlert error={holidays.error ?? add.error ?? remove.error} />

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Stack
						direction={{ xs: "column", sm: "row" }}
						spacing={2}
						sx={{ mt: 1 }}
					>
						<TextField
							label={t("admin.holiday.year")}
							value={year}
							onChange={event => setYear(event.target.value.replace(/\D/g, "").slice(0, 4))}
							sx={{ width: 140 }}
						/>
						<TextField
							label={t("admin.holiday.date")}
							type="date"
							value={date}
							size="small"
							InputLabelProps={{ shrink: true }}
							sx={{ width: 200 }}
							onChange={event => setDate(event.target.value)}
						/>
						<TextField
							label={t("admin.holiday.name")}
							value={name}
							onChange={event => setName(event.target.value)}
							fullWidth
						/>
						<TextField
							label={t("admin.holiday.region")}
							value={region}
							onChange={event => setRegion(event.target.value)}
							sx={{ width: 200 }}
						/>
					</Stack>
					<Box sx={{ mt: 2 }}>
						<Button
							variant="contained"
							disabled={!ready || add.isPending}
							onClick={() => add.mutate()}
						>
							{t("admin.holiday.add")}
						</Button>
					</Box>
				</CardContent>
			</Card>

			<Card>
				<List dense>
					{(holidays.data ?? []).map(holiday => (
						<ActionRow
							key={holiday.id}
							primary={`${formatDate(holiday.date, language)} · ${
								holiday.key ? t(`holiday.${holiday.key}`, { defaultValue: holiday.name }) : holiday.name
							}`}
							secondary={holiday.region ?? t("common.none")}
						>
							<Button
								size="small"
								color="error"
								onClick={() => remove.mutate(holiday.id)}
							>
								{t("admin.tag.delete")}
							</Button>
						</ActionRow>
					))}
					{!holidays.isLoading && (holidays.data ?? []).length === 0 && (
						<ListItem>
							<ListItemText secondary={t("admin.holiday.empty")} />
						</ListItem>
					)}
				</List>
			</Card>
		</>
	);
}
