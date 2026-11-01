import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  DASHBOARD_COLUMN_LIMIT,
  DEFAULT_DASHBOARD_COLUMNS,
  DEFAULT_ACTIVITY_COLUMN_ORDER,
  DEFAULT_ACTIVITY_COLUMN_COLORS,
  DEFAULT_ACTIVITY_COLUMN_NAMES,
  dashboardSettings,
  type ActivityColumnId,
  type ActivityColumnSettings,
  type DashboardColumn,
} from "../shared/settings";

const ACTIVITY_COLUMN_IDS: ActivityColumnId[] = ["unread", "needs-attention", "running"];

export function DashboardSettingsPanel({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(dashboardSettings);
  const [columns, setColumns] = useState<DashboardColumn[]>(
    DEFAULT_DASHBOARD_COLUMNS.map((column) => ({ ...column })),
  );
  const [activityColumns, setActivityColumns] = useState<ActivityColumnSettings>({
    unread: { name: DEFAULT_ACTIVITY_COLUMN_NAMES.unread, color: DEFAULT_ACTIVITY_COLUMN_COLORS.unread },
    "needs-attention": { name: DEFAULT_ACTIVITY_COLUMN_NAMES["needs-attention"], color: DEFAULT_ACTIVITY_COLUMN_COLORS["needs-attention"] },
    running: { name: DEFAULT_ACTIVITY_COLUMN_NAMES.running, color: DEFAULT_ACTIVITY_COLUMN_COLORS.running },
  });
  const [activityColumnOrder, setActivityColumnOrder] = useState<ActivityColumnId[]>(DEFAULT_ACTIVITY_COLUMN_ORDER);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const refs = useRef(new Map<string, SettingsInputHandle>());

  useEffect(() => {
    if (settings.status !== "ready") return;
    const next = settings.values.customColumns.map((column) => ({ ...column }));
    const nextActivityColumns = settings.values.activityColumns;
    const nextActivityOrder = [...settings.values.activityColumnOrder];
    setColumns(next);
    setActivityColumns(nextActivityColumns);
    setActivityColumnOrder(nextActivityOrder);
    for (const column of next) {
      refs.current.get(`${column.id}:name`)?.replaceText(column.name);
      refs.current.get(`${column.id}:color`)?.replaceText(column.color);
    }
    for (const id of ACTIVITY_COLUMN_IDS) {
      refs.current.get(`${id}:name`)?.replaceText(nextActivityColumns[id].name);
      refs.current.get(`${id}:color`)?.replaceText(nextActivityColumns[id].color);
    }
    setDirty(false);
    setSaved(false);
    setError("");
  }, [settings.status, settings.status === "ready" ? JSON.stringify([settings.values.customColumns, settings.values.activityColumns, settings.values.activityColumnOrder]) : ""]);

  const update = (id: string, field: "name" | "color", value: string): void => {
    setColumns((current) => current.map((column) => column.id === id ? { ...column, [field]: value } : column));
    setDirty(true);
    setSaved(false);
    setError("");
  };

  const updateActivity = (id: ActivityColumnId, field: "name" | "color", value: string): void => {
    setActivityColumns((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
    setDirty(true);
    setSaved(false);
    setError("");
  };

  const moveActivityColumn = (id: ActivityColumnId, direction: -1 | 1): void => {
    setActivityColumnOrder((current) => {
      const index = current.indexOf(id);
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    setDirty(true);
    setSaved(false);
  };

  const moveColumn = (id: string, direction: -1 | 1): void => {
    setColumns((current) => {
      const index = current.findIndex((column) => column.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    setDirty(true);
    setSaved(false);
  };

  const addColumn = (): void => {
    if (columns.length >= DASHBOARD_COLUMN_LIMIT) return;
    setColumns((current) => [...current, {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: `Column ${current.length + 1}`,
      color: "#94a3b8",
    }]);
    setDirty(true);
    setSaved(false);
  };

  const removeColumn = (id: string): void => {
    if (columns.length <= 1) return;
    setColumns((current) => current.filter((column) => column.id !== id));
    setDirty(true);
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    if (settings.status !== "ready") return;
    const normalized = columns.map((column) => ({
      ...column,
      name: column.name.trim().replace(/\s+/g, " "),
      color: column.color.trim().toUpperCase(),
    }));
    const normalizedActivity = Object.fromEntries(ACTIVITY_COLUMN_IDS.map((id) => [id, {
      name: activityColumns[id].name.trim().replace(/\s+/g, " "),
      color: activityColumns[id].color.trim().toUpperCase(),
    }])) as ActivityColumnSettings;
    if (normalized.some((column) => !column.name || column.name.length > 40)
      || ACTIVITY_COLUMN_IDS.some((id) => !normalizedActivity[id].name || normalizedActivity[id].name.length > 40)) {
      setError("Column names must contain 1 to 40 characters.");
      return;
    }
    if (normalized.some((column) => !/^#[0-9A-F]{6}$/.test(column.color))
      || ACTIVITY_COLUMN_IDS.some((id) => !/^#[0-9A-F]{6}$/.test(normalizedActivity[id].color))) {
      setError("Use a six-digit hex color, such as #94A3B8.");
      return;
    }
    if (new Set(normalized.map((column) => column.id)).size !== normalized.length) {
      setError("Column IDs must be unique.");
      return;
    }
    const didSave = await settings.save({
      dashboardViews: settings.values.dashboardViews,
      customColumns: normalized,
      activityColumns: normalizedActivity,
      activityColumnOrder,
    }, settings.revision);
    setColumns(normalized);
    setActivityColumns(normalizedActivity);
    setDirty(!didSave);
    setSaved(didSave);
    setError(didSave ? "" : "Could not save. The settings changed elsewhere; reload and try again.");
  };

  const colors = theme.colors;
  const titleStyle = { color: colors.foreground, fontSize: 22, fontWeight: "700" as const };
  const hintStyle = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 };

  return (
    <View style={{ flex: 1, padding: layout.compact ? 14 : 24, gap: 18, backgroundColor: colors.surface0 }}>
      <View style={{ gap: 8 }}>
        <Text style={titleStyle}>Paseo Dashboard settings</Text>
        <Text style={hintStyle}>
          Unread, Needs attention, and Running are automatically organized from Paseo activity. Customize their names and colors, then organize workspaces in the columns below.
        </Text>
        <Text style={hintStyle}>Column assignments and ordering are saved host-wide.</Text>
      </View>

      {settings.status === "loading" ? <Text style={hintStyle}>Loading settings…</Text> : null}
      {settings.status === "error" || settings.status === "invalid" ? (
        <Text style={{ color: colors.statusDanger, fontSize: 13 }}>{settings.error}</Text>
      ) : null}

      {settings.status === "ready" ? (
        <>
          <SettingsSection title="Agent activity columns">
            <Text style={hintStyle}>These columns always stay in the board and keep their automatic activity grouping. Reorder them and customize their names and colors.</Text>
            <View style={{ gap: 10, marginTop: 12 }}>
              {activityColumnOrder.map((id, index) => (
                <SettingsCard key={id}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>{DEFAULT_ACTIVITY_COLUMN_NAMES[id]}</Text>
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${activityColumns[id].name} up`}
                        disabled={index === 0}
                        onPress={() => moveActivityColumn(id, -1)}
                        style={{ paddingHorizontal: 9, paddingVertical: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 7, opacity: index === 0 ? 0.45 : 1 }}
                      ><Text style={{ color: colors.foreground }}>Up</Text></Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${activityColumns[id].name} down`}
                        disabled={index === activityColumnOrder.length - 1}
                        onPress={() => moveActivityColumn(id, 1)}
                        style={{ paddingHorizontal: 9, paddingVertical: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 7, opacity: index === activityColumnOrder.length - 1 ? 0.45 : 1 }}
                      ><Text style={{ color: colors.foreground }}>Down</Text></Pressable>
                    </View>
                  </View>
                  <SettingsInput
                    ref={(input) => {
                      if (input) refs.current.set(`${id}:name`, input);
                      else refs.current.delete(`${id}:name`);
                    }}
                    label="Column name"
                    initialValue={activityColumns[id].name}
                    onChangeText={(value) => updateActivity(id, "name", value)}
                  />
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: /^#[0-9a-fA-F]{6}$/.test(activityColumns[id].color) ? activityColumns[id].color : colors.foregroundMuted }} />
                    <View style={{ flex: 1 }}>
                      <SettingsInput
                        ref={(input) => {
                          if (input) refs.current.set(`${id}:color`, input);
                          else refs.current.delete(`${id}:color`);
                        }}
                        label="Accent color (hex)"
                        initialValue={activityColumns[id].color}
                        onChangeText={(value) => updateActivity(id, "color", value)}
                        placeholder="#4ADE80"
                      />
                    </View>
                  </View>
                </SettingsCard>
              ))}
            </View>
          </SettingsSection>

          <SettingsSection title={`Workspace organization (${columns.length})`}>
            <Text style={hintStyle}>
              Rename, recolor, reorder, add, or remove these columns. Drag workspaces between them to organize your board. Maximum {DASHBOARD_COLUMN_LIMIT}.
            </Text>
            <View style={{ gap: 10, marginTop: 12 }}>
              {columns.map((column, index) => (
                <SettingsCard key={column.id}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                      Column {index + 1}
                    </Text>
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${column.name} up`}
                        disabled={index === 0}
                        onPress={() => moveColumn(column.id, -1)}
                        style={{ paddingHorizontal: 9, paddingVertical: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 7, opacity: index === 0 ? 0.45 : 1 }}
                      ><Text style={{ color: colors.foreground }}>Up</Text></Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${column.name} down`}
                        disabled={index === columns.length - 1}
                        onPress={() => moveColumn(column.id, 1)}
                        style={{ paddingHorizontal: 9, paddingVertical: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 7, opacity: index === columns.length - 1 ? 0.45 : 1 }}
                      ><Text style={{ color: colors.foreground }}>Down</Text></Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${column.name} column`}
                        disabled={columns.length <= 1}
                        onPress={() => removeColumn(column.id)}
                        style={{ paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: colors.border, borderRadius: 7, opacity: columns.length <= 1 ? 0.45 : 1 }}
                      ><Text style={{ color: colors.foreground }}>Remove</Text></Pressable>
                    </View>
                  </View>
                  <SettingsInput
                    ref={(input) => {
                      if (input) refs.current.set(`${column.id}:name`, input);
                      else refs.current.delete(`${column.id}:name`);
                    }}
                    label="Column name"
                    initialValue={column.name}
                    onChangeText={(value) => update(column.id, "name", value)}
                    placeholder="Column name"
                  />
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: /^#[0-9a-fA-F]{6}$/.test(column.color) ? column.color : colors.foregroundMuted }} />
                    <View style={{ flex: 1 }}>
                      <SettingsInput
                        ref={(input) => {
                          if (input) refs.current.set(`${column.id}:color`, input);
                          else refs.current.delete(`${column.id}:color`);
                        }}
                        label="Accent color (hex)"
                        initialValue={column.color}
                        onChangeText={(value) => update(column.id, "color", value)}
                        placeholder="#94A3B8"
                      />
                    </View>
                  </View>
                </SettingsCard>
              ))}
              <Pressable
                accessibilityRole="button"
                disabled={columns.length >= DASHBOARD_COLUMN_LIMIT}
                onPress={addColumn}
                style={{ alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, opacity: columns.length >= DASHBOARD_COLUMN_LIMIT ? 0.5 : 1 }}
              >
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>Add column</Text>
              </Pressable>
            </View>
          </SettingsSection>

          <View style={{ flexDirection: layout.compact ? "column" : "row", alignItems: layout.compact ? "stretch" : "center", justifyContent: "space-between", gap: 12 }}>
            <View>
              {error ? <Text style={{ color: colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
              {saved ? <Text style={{ color: colors.statusSuccess, fontSize: 13 }}>Settings saved.</Text> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={!dirty || settings.saving}
              onPress={() => void save()}
              style={{ minHeight: 42, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, borderRadius: 9, backgroundColor: colors.accent, opacity: !dirty || settings.saving ? 0.55 : 1 }}
            >
              <Text style={{ color: colors.accentForeground, fontSize: 14, fontWeight: "700" }}>{settings.saving ? "Saving…" : "Save settings"}</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </View>
  );
}
