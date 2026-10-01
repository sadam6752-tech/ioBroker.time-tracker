/**
 * Administration: imageProblemText, PictureField, BrandImageField, RAW_SETTING_LABEL_KEYS, RawSettingField, SettingsTab (split out of `Admin.tsx`).
 */

import Alert from "@mui/material/Alert";
import { type AutomationRule, api } from "../../api/client";
import { BRANDING_MAX_BYTES, type ImageProblem, prepareImage } from "../../components/image-file";
import { BRAND_PRESET_COLORS } from "../../state/branding";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import { ErrorAlert, Loading } from "../../components/feedback";
import MenuItem from "@mui/material/MenuItem";
import { type PauseRule } from "../../api/types";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { hasPermission, useSession } from "../../state/session";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AbsenceTypesCard } from "./AbsenceTypesCard";
import { AutomationRulesCard } from "./TriggersTab";
import { PauseRuleTable } from "./UsersTab";
import { formatSize } from "./helpers";

/**
 * Text key of a picture problem.
 *
 * @param problem - reason reported by `prepareImage`
 * @returns text key
 */
function imageProblemText(problem: ImageProblem): string {
	if (problem === "type") {
		return "admin.brand.imageType";
	}
	return problem === "tooLarge" ? "admin.brand.imageTooLarge" : "admin.brand.imageUnreadable";
}

/**
 * Button that picks a picture and prepares it for the server.
 *
 * A picture straight from a phone is far bigger than the API accepts, so `prepareImage` scales it down and this
 * field reports what happened.
 *
 * @param props - label, limit and handlers
 * @param props.label - text of the button
 * @param props.maxBytes - limit of the data URL (the same value the server checks)
 * @param props.hint - optional text under the button
 * @param props.onChange - called with the prepared data URL
 * @param props.disabled - true without the right to change the value
 * @returns the field
 */
export function PictureField({
	label,
	maxBytes,
	hint,
	onChange,
	disabled,
}: {
	label: string;
	maxBytes: number;
	hint?: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const [problem, setProblem] = useState<ImageProblem | null>(null);
	const [resized, setResized] = useState("");

	return (
		<Stack spacing={1}>
			<Button
				variant="outlined"
				component="label"
				disabled={disabled === true}
				sx={{ alignSelf: "flex-start" }}
			>
				{label}
				<input
					hidden
					type="file"
					accept="image/png,image/jpeg,image/webp,image/gif"
					onChange={event => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (!file) {
							return;
						}
						setProblem(null);
						setResized("");
						void prepareImage(file, maxBytes).then(result => {
							if (!result.ok) {
								setProblem(result.problem);
								return;
							}
							onChange(result.image.dataUrl);
							if (result.image.resized) {
								setResized(
									t("admin.brand.imageResized", {
										size: formatSize(result.image.bytes, i18n.language),
									}),
								);
							}
						});
					}}
				/>
			</Button>
			{hint && (
				<Typography
					variant="body2"
					color="text.secondary"
				>
					{hint}
				</Typography>
			)}
			{resized && (
				<Typography
					variant="body2"
					color="text.secondary"
				>
					{resized}
				</Typography>
			)}
			{problem && <Alert severity="warning">{t(imageProblemText(problem))}</Alert>}
		</Stack>
	);
}

/**
 * Picks a picture of the branding (logo or background).
 *
 * @param props - label, current value, limit and handlers
 * @param props.label - text of the button
 * @param props.value - current data URL, empty when nothing is set
 * @param props.maxBytes - limit of the data URL (the same value the server checks)
 * @param props.onChange - called with the new data URL; an empty string removes the picture
 * @param props.disabled - true without the right to change settings
 * @returns the field
 */
function BrandImageField({
	label,
	value,
	maxBytes,
	onChange,
	disabled,
}: {
	label: string;
	value: string;
	maxBytes: number;
	onChange: (value: string) => void;
	disabled: boolean;
}): React.JSX.Element {
	const { t } = useTranslation();

	return (
		<Stack
			direction={{ xs: "column", sm: "row" }}
			spacing={2}
			sx={{ alignItems: { sm: "center" } }}
		>
			<PictureField
				label={label}
				maxBytes={maxBytes}
				onChange={onChange}
				disabled={disabled}
			/>
			{value !== "" && (
				<>
					<Box
						component="img"
						src={value}
						alt=""
						sx={{ height: 40, maxWidth: 160, objectFit: "contain", border: 1, borderColor: "divider" }}
					/>
					<Button
						color="inherit"
						title={t("admin.settings.brandImageRemove")}
						disabled={disabled}
						onClick={() => onChange("")}
					>
						{t("admin.settings.brandImageRemove")}
					</Button>
				</>
			)}
		</Stack>
	);
}

/**
 * Settings whose label already exists somewhere else, so the raw editor does not repeat the text.
 */
const RAW_SETTING_LABEL_KEYS: Record<string, string> = {
	pause_mode: "admin.settings.pauseModeTitle",
};

/**
 * One raw instance setting: a readable label with the technical name in the small line below it.
 *
 * @param props - setting, value, write state and layout
 * @param props.settingKey - technical name of the setting
 * @param props.value - current value
 * @param props.disabled - true when the caller may not write
 * @param props.onChange - called with the new value
 * @param props.fullLine - true to run over the whole line (the time zone needs the room)
 * @returns the field
 */
function RawSettingField({
	settingKey,
	value,
	disabled,
	onChange,
	fullLine = false,
}: {
	settingKey: string;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
	fullLine?: boolean;
}): React.JSX.Element {
	const { t } = useTranslation();
	const labelKey = RAW_SETTING_LABEL_KEYS[settingKey] ?? `admin.settings.setting.${settingKey}`;
	return (
		<TextField
			label={t(labelKey, { defaultValue: settingKey })}
			// the technical name stays visible: this block is the raw editor of the instance settings
			helperText={settingKey}
			value={value}
			onChange={event => onChange(event.target.value)}
			disabled={disabled}
			size="small"
			fullWidth
			{...(fullLine ? { sx: { gridColumn: { xs: "auto", md: "1 / -1" } } } : {})}
		/>
	);
}

/**
 * Instance settings: the font for the PDF statements and a technical editor for the rest.
 *
 * @returns the settings tab
 */

/**
 * The instance settings of the administration, with the branding pictures and the absence types.
 *
 * @returns the tab
 */
export function SettingsTab(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { permissions } = useSession();
	const mayEdit = hasPermission(permissions, "settings.edit");
	const queryClient = useQueryClient();
	const settings = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api.settings() });
	const pauseRules = useQuery({ queryKey: ["admin", "pauseRules"], queryFn: () => api.pauseRules() });
	// the settings read leaves the large pictures out, so the fields take their pictures from the branding route
	const branding = useQuery({ queryKey: ["branding"], queryFn: () => api.branding() });
	const [draft, setDraft] = useState<Record<string, string>>({});
	// `null` shows what the server has; the first change keeps a local copy until it is saved
	const [rules, setRules] = useState<PauseRule[] | null>(null);
	const shownRules = rules ?? pauseRules.data ?? [];

	const savePauseRules = useMutation({
		mutationFn: (list: PauseRule[]) => api.savePauseRules(list),
		onSuccess: async () => {
			setRules(null);
			await queryClient.invalidateQueries({ queryKey: ["admin", "pauseRules"] });
		},
	});

	// automation rules: the adapter follows them on its own, the runs are its log
	const people = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.users() });
	const automations = useQuery({ queryKey: ["admin", "automations"], queryFn: () => api.automationRules() });
	const automationRuns = useQuery({ queryKey: ["admin", "automationRuns"], queryFn: () => api.automationRuns() });
	const absenceTypes = useQuery({ queryKey: ["absence-types", "all"], queryFn: () => api.absenceTypes(true) });
	const [automationDraft, setAutomationDraft] = useState<AutomationRule[] | null>(null);
	const shownAutomations = automationDraft ?? automations.data ?? [];

	const saveAutomations = useMutation({
		mutationFn: (list: AutomationRule[]) => api.saveAutomationRules(list),
		onSuccess: async () => {
			setAutomationDraft(null);
			await queryClient.invalidateQueries({ queryKey: ["admin", "automations"] });
			await queryClient.invalidateQueries({ queryKey: ["admin", "automationRuns"] });
		},
	});

	const save = useMutation({
		mutationFn: (patch: Record<string, string>) => api.updateSettings(patch),
		onSuccess: async () => {
			setDraft({});
			await queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
			// logo, background and colour are painted by the app shell and shown by the kiosk screens
			await queryClient.invalidateQueries({ queryKey: ["branding"] });
		},
	});

	if (settings.isLoading) {
		return <Loading />;
	}

	const values = settings.data ?? {};

	// an uploaded picture is in the change set; otherwise the stored picture comes from the branding route
	const currentLogo = draft.brand_logo ?? branding.data?.logoUrl ?? "";
	const currentBackground = draft.brand_background ?? branding.data?.backgroundUrl ?? "";

	/**
	 * Keeps one setting in the pending change set.
	 *
	 * @param key - name of the setting
	 * @param value - new value
	 */
	const change = (key: string, value: string): void => setDraft(current => ({ ...current, [key]: value }));

	return (
		<>
			<ErrorAlert
				error={settings.error ?? branding.error ?? save.error ?? pauseRules.error ?? savePauseRules.error}
			/>
			{save.isSuccess && (
				<Alert
					severity="success"
					sx={{ mb: 2 }}
				>
					{t("admin.settings.saved")}
				</Alert>
			)}

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.settings.branding")}
					</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
						gutterBottom
					>
						{t("admin.settings.brandingHint")}
					</Typography>
					<Stack spacing={2}>
						<BrandImageField
							label={t("admin.settings.brandLogo")}
							value={currentLogo}
							maxBytes={BRANDING_MAX_BYTES}
							onChange={value => change("brand_logo", value)}
							disabled={!mayEdit}
						/>
						<BrandImageField
							label={t("admin.settings.brandBackground")}
							value={currentBackground}
							maxBytes={BRANDING_MAX_BYTES}
							onChange={value => change("brand_background", value)}
							disabled={!mayEdit}
						/>
						<Stack
							direction="row"
							spacing={2}
							sx={{ alignItems: "center" }}
						>
							<TextField
								label={t("admin.settings.brandColor")}
								helperText={t("admin.settings.brandColorHint")}
								value={draft.brand_color ?? values.brand_color ?? ""}
								onChange={event => change("brand_color", event.target.value)}
								disabled={!mayEdit}
								sx={{ maxWidth: 260 }}
							/>
							{(draft.brand_color ?? values.brand_color ?? "") !== "" && (
								<Box
									sx={{
										width: 32,
										height: 32,
										borderRadius: 1,
										border: 1,
										borderColor: "divider",
										bgcolor: draft.brand_color ?? values.brand_color ?? "transparent",
									}}
								/>
							)}
						</Stack>
						{/* the suggestions save typing: one click sets the colour, the field above stays for anything else */}
						<Stack spacing={1}>
							<Typography
								variant="body2"
								color="text.secondary"
							>
								{t("admin.settings.brandColorPresets")}
							</Typography>
							<Stack
								direction="row"
								sx={{ flexWrap: "wrap", gap: 1, alignItems: "center" }}
							>
								{BRAND_PRESET_COLORS.map(color => (
									<Button
										key={color}
										aria-label={color}
										title={color}
										disabled={!mayEdit}
										onClick={() => change("brand_color", color)}
										sx={{
											minWidth: 40,
											width: 40,
											height: 40,
											p: 0,
											borderRadius: 1,
											border: 2,
											borderColor:
												(draft.brand_color ?? values.brand_color ?? "").toLowerCase() === color
													? "primary.main"
													: "divider",
											bgcolor: color,
											"&:hover": { bgcolor: color },
										}}
									/>
								))}
								<Button
									color="inherit"
									title={t("admin.settings.brandColorDefaultHint")}
									disabled={!mayEdit}
									onClick={() => {
										// "default" also takes the background picture away: one click leads back to the plain look
										change("brand_color", "");
										change("brand_background", "");
									}}
								>
									{t("admin.settings.brandColorDefault")}
								</Button>
							</Stack>
						</Stack>
					</Stack>
				</CardContent>
			</Card>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<TextField
						label={t("admin.settings.fontPath")}
						helperText={t("admin.settings.fontPathHint")}
						value={draft.report_font_path ?? values.report_font_path ?? ""}
						onChange={event => change("report_font_path", event.target.value)}
						disabled={!mayEdit}
						fullWidth
					/>
				</CardContent>
			</Card>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.settings.advanced")}
					</Typography>
					<Box
						sx={{
							display: "grid",
							gap: 2,
							// three settings per line on a wide screen — the values are short — and one on a phone
							gridTemplateColumns: {
								xs: "1fr",
								sm: "repeat(2, minmax(0, 1fr))",
								md: "repeat(3, minmax(0, 1fr))",
							},
						}}
					>
						{Object.keys(values)
							.filter(key => !key.startsWith("brand_") && !key.endsWith("timezone"))
							.sort()
							.map(key => (
								<RawSettingField
									key={key}
									settingKey={key}
									value={draft[key] ?? values[key] ?? ""}
									disabled={!mayEdit}
									onChange={next => change(key, next)}
								/>
							))}
						{/* the time zone carries the longest value and gets a line of its own */}
						{Object.keys(values)
							.filter(key => key.endsWith("timezone"))
							.map(key => (
								<RawSettingField
									key={key}
									settingKey={key}
									value={draft[key] ?? values[key] ?? ""}
									disabled={!mayEdit}
									onChange={next => change(key, next)}
									fullLine
								/>
							))}
					</Box>
				</CardContent>
			</Card>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.settings.pauseRules")}
					</Typography>
					<Typography
						variant="body2"
						color="text.secondary"
						gutterBottom
					>
						{t("admin.settings.pauseRulesHint")}
					</Typography>
					<PauseRuleTable
						rules={shownRules}
						disabled={!mayEdit}
						saving={savePauseRules.isPending}
						onChange={setRules}
						onSave={() => savePauseRules.mutate(shownRules)}
					/>
				</CardContent>
			</Card>

			<AutomationRulesCard
				rules={shownAutomations}
				runs={automationRuns.data ?? []}
				people={people.data ?? []}
				disabled={!mayEdit}
				saving={saveAutomations.isPending}
				onChange={setAutomationDraft}
				onSave={() => saveAutomations.mutate(shownAutomations)}
				language={i18n.language}
			/>

			<AbsenceTypesCard
				types={absenceTypes.data ?? []}
				disabled={!hasPermission(permissions, "absence.manage_types")}
				onSaved={() => void queryClient.invalidateQueries({ queryKey: ["absence-types"] })}
			/>

			<Card sx={{ mb: 2 }}>
				<CardContent>
					<Typography
						variant="subtitle1"
						gutterBottom
					>
						{t("admin.settings.pauseMode")}
					</Typography>
					<TextField
						select
						fullWidth
						label={t("admin.settings.pauseModeTitle")}
						helperText={t("admin.settings.pauseModeHint")}
						value={draft.pause_mode ?? values.pause_mode ?? "auto"}
						onChange={event => change("pause_mode", event.target.value)}
						disabled={!mayEdit}
					>
						{["auto", "punched", "staffel"].map(mode => (
							<MenuItem
								key={mode}
								value={mode}
							>
								{t(`admin.settings.pauseMode.${mode}`)}
							</MenuItem>
						))}
					</TextField>
				</CardContent>
			</Card>

			<Button
				variant="contained"
				disabled={!mayEdit || Object.keys(draft).length === 0 || save.isPending}
				onClick={() => save.mutate(draft)}
			>
				{t("common.save")}
			</Button>
		</>
	);
}
