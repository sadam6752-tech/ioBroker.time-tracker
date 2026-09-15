/**
 * Frame of the web app: navigation, offline hint and sign out.
 */
import AppBar from "@mui/material/AppBar";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import BottomNavigation from "@mui/material/BottomNavigation";
import BottomNavigationAction from "@mui/material/BottomNavigationAction";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import BarChartIcon from "@mui/icons-material/BarChart";
import InsightsIcon from "@mui/icons-material/Insights";
import BeachAccessIcon from "@mui/icons-material/BeachAccess";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import MenuIcon from "@mui/icons-material/Menu";
import SyncIcon from "@mui/icons-material/Sync";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { hasPermission, useSession } from "../state/session";
import { useSync } from "../offline/useSync";
import { useLiveEvents } from "../live/useLiveEvents";

/** Entries of the navigation. */
const TABS = [
	{ path: "/", key: "nav.dashboard", icon: <AccessTimeIcon /> },
	{ path: "/month", key: "nav.month", icon: <CalendarMonthIcon /> },
	{ path: "/reports", key: "nav.reports", icon: <BarChartIcon /> },
	{ path: "/statistics", key: "nav.statistics", icon: <InsightsIcon /> },
	{ path: "/absences", key: "nav.absences", icon: <BeachAccessIcon /> },
	{ path: "/sync", key: "nav.sync", icon: <SyncIcon /> },
];

/**
 * Frame around every screen.
 *
 * @param props - title and content
 * @param props.title - heading of the screen
 * @param props.children - content
 * @returns the shell
 */
export function AppShell({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
	const { t } = useTranslation();
	const { session, signOut } = useSession();
	const { pending, online } = useSync();
	// the figures on the screen follow the server: a punch at the terminal refreshes an open dashboard
	useLiveEvents(session !== null);
	// the administration is only offered to callers who may use at least one of its tabs
	const { permissions } = useSession();
	const mayAdminister = hasPermission(permissions, "user.view") || hasPermission(permissions, "backup.run");
	const navigate = useNavigate();
	const location = useLocation();
	const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

	const active = TABS.find(tab => tab.path === location.pathname)?.path ?? "/";

	return (
		<Box sx={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
			<AppBar
				position="sticky"
				color="primary"
				enableColorOnDark
			>
				<Toolbar
					variant="dense"
					sx={{ gap: 1 }}
				>
					<Typography
						variant="h6"
						sx={{ flexGrow: 1 }}
					>
						{t("app.title")}
					</Typography>

					{!online && (
						<Chip
							size="small"
							color="warning"
							icon={<CloudOffIcon />}
							label={t("app.offline")}
						/>
					)}
					{pending.length > 0 && (
						<Chip
							size="small"
							color="secondary"
							icon={<SyncIcon />}
							label={t("sync.pending", { count: pending.length })}
							onClick={() => void navigate("/sync")}
						/>
					)}

					<IconButton
						color="inherit"
						onClick={event => setMenuAnchor(event.currentTarget)}
						title={t("nav.menu")}
					>
						<MenuIcon />
					</IconButton>
				</Toolbar>
			</AppBar>

			<Menu
				anchorEl={menuAnchor}
				open={menuAnchor !== null}
				onClose={() => setMenuAnchor(null)}
			>
				<MenuItem disabled>
					<Typography variant="body2">{session?.user.displayName ?? session?.user.login}</Typography>
				</MenuItem>
				{mayAdminister && (
					<MenuItem
						onClick={() => {
							setMenuAnchor(null);
							void navigate("/admin");
						}}
					>
						{t("admin.title")}
					</MenuItem>
				)}
				<MenuItem
					onClick={() => {
						setMenuAnchor(null);
						void navigate("/profile");
					}}
				>
					{t("nav.profile")}
				</MenuItem>
				<MenuItem
					onClick={() => {
						setMenuAnchor(null);
						void signOut();
					}}
				>
					{t("nav.logout")}
				</MenuItem>
			</Menu>

			<Container
				maxWidth="sm"
				sx={{ py: 2, flexGrow: 1 }}
			>
				<Typography
					variant="h5"
					component="h1"
					sx={{ mb: 2 }}
				>
					{title}
				</Typography>
				{children}
			</Container>

			<Box
				sx={{
					position: "sticky",
					bottom: 0,
					borderTop: 1,
					borderColor: "divider",
					bgcolor: "background.paper",
				}}
			>
				<BottomNavigation
					value={active}
					showLabels
					onChange={(_event, value: string) => void navigate(value)}
					sx={{ maxWidth: 600, mx: "auto" }}
				>
					{TABS.map(tab => (
						<BottomNavigationAction
							key={tab.path}
							value={tab.path}
							label={t(tab.key)}
							icon={
								tab.key === "nav.sync" ? (
									<Badge
										color="secondary"
										badgeContent={pending.length}
										overlap="circular"
									>
										{tab.icon}
									</Badge>
								) : (
									tab.icon
								)
							}
						/>
					))}
				</BottomNavigation>
			</Box>
		</Box>
	);
}

/**
 * Placeholder for screens that are still to come.
 *
 * @param props - title and description
 * @param props.title - heading
 * @param props.description - translation key of the hint
 * @returns the placeholder
 */
export function Placeholder({ title, description }: { title: string; description: string }): React.JSX.Element {
	const { t } = useTranslation();
	return (
		<AppShell title={title}>
			<Button
				variant="outlined"
				disabled
			>
				{t(description)}
			</Button>
		</AppShell>
	);
}
