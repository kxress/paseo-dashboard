import type { PluginServerContext } from "@getpaseo/plugin/server";
import { dashboardOrganizationSettings, dashboardSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext): () => void {
  server.registerSettings(dashboardSettings);
  server.registerSettings(dashboardOrganizationSettings);
  return () => {};
}
