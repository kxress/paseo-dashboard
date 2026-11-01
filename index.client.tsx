import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentDashboard, AgentDashboardSidebarItem } from "./client/dashboard";
import { DashboardSettingsPanel } from "./client/dashboard-settings-panel";

export default function contribute(client: PluginClientContext): () => void {
  const removeDashboard = client.addScreen({
    id: "dashboard",
    title: "Paseo Dashboard",
    Component: AgentDashboard,
  });
  const removeSidebarItem = client.addSidebarHeaderItem({
    id: "dashboard",
    title: "Paseo Dashboard",
    Component: AgentDashboardSidebarItem,
  });
  const removeSettingsScreen = client.addSettingsScreen({
    id: "settings",
    title: "Paseo Dashboard settings",
    icon: "LayoutDashboard",
    Component: DashboardSettingsPanel,
  });

  return () => {
    removeSettingsScreen();
    removeSidebarItem();
    removeDashboard();
  };
}
