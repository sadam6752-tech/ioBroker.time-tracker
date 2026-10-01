/**
 * Administration: employees and database backups.
 *
 * The screen only offers what the caller is allowed to do — the server checks the permissions again, the UI
 * just avoids showing buttons that would fail. It is reachable from the menu, not from the bottom navigation,
 * because most users never need it.
 */

import { AbsencesTab } from "./AbsencesTab";
import Alert from "@mui/material/Alert";
import { AppShell } from "../components/AppShell";
import { CorrectionsTab } from "./CorrectionsTab";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { hasPermission, useSession } from "../state/session";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BackupTab } from "./admin/BackupTab";
import { HolidaysTab } from "./admin/HolidaysTab";
import { SettingsTab } from "./admin/SettingsTab";
import { TagsTab } from "./admin/TagsTab";
import { TerminalsTab } from "./admin/TerminalsTab";
import { TriggersTab } from "./admin/TriggersTab";
import { UsersTab } from "./admin/UsersTab";

/**
 * Shows the administration.
 *
 * @returns the admin screen
 */
export function Admin(): React.JSX.Element {
	const { t, i18n } = useTranslation();
	const { permissions } = useSession();
	const [tab, setTab] = useState(0);

	// only the tabs the caller may use become part of the screen; the server checks each request again
	const tabs: { label: string; render: () => React.JSX.Element }[] = [];
	if (hasPermission(permissions, "user.view")) {
		tabs.push({ label: t("admin.users"), render: () => <UsersTab language={i18n.language} /> });
	}
	// correcting punches is the everyday administrative task, so it sits right next to the employees
	if (hasPermission(permissions, "time.edit_other")) {
		tabs.push({ label: t("admin.corrections"), render: () => <CorrectionsTab language={i18n.language} /> });
	}
	// absences: the requests of the employees wait here for their decision, and “who is away” is answered here
	if (hasPermission(permissions, "absence.approve")) {
		tabs.push({ label: t("admin.absences.title"), render: () => <AbsencesTab language={i18n.language} /> });
	}
	if (hasPermission(permissions, "terminal.manage")) {
		tabs.push({ label: t("admin.terminals"), render: () => <TerminalsTab language={i18n.language} /> });
	}
	if (hasPermission(permissions, "settings.view")) {
		tabs.push({ label: t("admin.settings"), render: () => <SettingsTab /> });
	}
	if (hasPermission(permissions, "holiday.manage")) {
		tabs.push({ label: t("admin.holidays"), render: () => <HolidaysTab language={i18n.language} /> });
	}
	if (hasPermission(permissions, "rfid.manage")) {
		tabs.push({ label: t("admin.tags"), render: () => <TagsTab language={i18n.language} /> });
	}
	// rules that turn a state of another adapter into a punch: fingerprint reader, button, door contact
	if (hasPermission(permissions, "settings.view")) {
		tabs.push({ label: t("admin.triggers"), render: () => <TriggersTab language={i18n.language} /> });
	}
	if (hasPermission(permissions, "backup.run")) {
		tabs.push({ label: t("admin.backup"), render: () => <BackupTab language={i18n.language} /> });
	}

	if (tabs.length === 0) {
		return (
			<AppShell title={t("admin.title")}>
				<Alert severity="info">{t("admin.forbidden")}</Alert>
			</AppShell>
		);
	}

	// a permission change can leave the index behind, so it is clamped to the allowed range
	const active = Math.min(tab, tabs.length - 1);

	return (
		<AppShell title={t("admin.title")}>
			<Tabs
				value={active}
				onChange={(_event, value: number) => setTab(value)}
				// scrollable instead of fullWidth: the labels do not fit a wide window when squeezed, and a
				// clipped tab name is worse than a scrollable row
				variant="scrollable"
				scrollButtons="auto"
				allowScrollButtonsMobile
				sx={{ mb: 2 }}
			>
				{tabs.map(entry => (
					<Tab
						key={entry.label}
						label={entry.label}
					/>
				))}
			</Tabs>

			{tabs[active]?.render()}
		</AppShell>
	);
}
