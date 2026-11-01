import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (settings.status !== "ready") return;
    const next = settings.values.customColumns.map((column) => ({ ...column }));
    const nextActivityColumns = settings.values.activityColumns;
    const nextActivityOrder = [...settings.values.activityColumnOrder];
    setColumns(next);
    setActivityColumns(nextActivityColumns);
    setActivityColumnOrder(nextActivityOrder);
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
  const fieldLabelStyle = { color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const };
  const inputFrameStyle = {
    minHeight: 40,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface1,
  };
  const inputTextStyle = {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 11,
    paddingVertical: 8,
    color: colors.foreground,
    fontSize: 13,
  };
  const actionButtonStyle = {
    minHeight: 32,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 7,
    backgroundColor: colors.surface1,
  };
  const renderColumnCard = (column: {
    id: string;
    title: string;
    name: string;
    color: string;
    index: number;
    count: number;
    onNameChange: (value: string) => void;
    onColorChange: (value: string) => void;
    onMove: (direction: -1 | 1) => void;
    onRemove?: () => void;
  }) => {
    const validColor = /^#[0-9a-fA-F]{6}$/.test(column.color);
    const moveButton = (direction: -1 | 1, label: string, disabled: boolean) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} ${column.title}`}
        disabled={disabled}
        onPress={() => column.onMove(direction)}
        style={[actionButtonStyle, { opacity: disabled ? 0.45 : 1 }]}
      >
        <Text style={{ color: disabled ? colors.foregroundMuted : colors.foreground, fontSize: 12, fontWeight: "600" }}>{label}</Text>
      </Pressable>
    );

    return (
      <SettingsCard key={column.id}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 9 }}>
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: validColor ? column.color : colors.foregroundMuted }} />
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>{column.title}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {moveButton(-1, "Up", column.index === 0)}
            {moveButton(1, "Down", column.index === column.count - 1)}
            {column.onRemove ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${column.title} column`}
                disabled={column.count <= 1}
                onPress={column.onRemove}
                style={[actionButtonStyle, { borderColor: colors.statusDanger, opacity: column.count <= 1 ? 0.45 : 1 }]}
              >
                <Text style={{ color: colors.statusDanger, fontSize: 12, fontWeight: "600" }}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 12, padding: 12 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <Text style={fieldLabelStyle}>Column name</Text>
            <View style={inputFrameStyle}>
              <TextInput
                accessibilityLabel={`${column.title} column name`}
                value={column.name}
                onChangeText={column.onNameChange}
                placeholder="Column name"
                placeholderTextColor={colors.foregroundMuted}
                maxLength={40}
                style={inputTextStyle}
              />
            </View>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <Text style={fieldLabelStyle}>Accent color</Text>
            <View style={[inputFrameStyle, { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 10 }]}>
              <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: validColor ? column.color : colors.foregroundMuted }} />
              <TextInput
                accessibilityLabel={`${column.title} accent color`}
                value={column.color}
                onChangeText={column.onColorChange}
                placeholder="#94A3B8"
                placeholderTextColor={colors.foregroundMuted}
                autoCapitalize="characters"
                maxLength={7}
                style={[inputTextStyle, { paddingLeft: 0 }]}
              />
            </View>
          </View>
        </View>
      </SettingsCard>
    );
  };

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
              {activityColumnOrder.map((id, index) => renderColumnCard({
                id,
                title: activityColumns[id].name || DEFAULT_ACTIVITY_COLUMN_NAMES[id],
                name: activityColumns[id].name,
                color: activityColumns[id].color,
                index,
                count: activityColumnOrder.length,
                onNameChange: (value) => updateActivity(id, "name", value),
                onColorChange: (value) => updateActivity(id, "color", value),
                onMove: (direction) => moveActivityColumn(id, direction),
              }))}
            </View>
          </SettingsSection>

          <SettingsSection title={`Workspace organization (${columns.length})`}>
            <Text style={hintStyle}>
              Rename, recolor, reorder, add, or remove these columns. Drag workspaces between them to organize your board. Maximum {DASHBOARD_COLUMN_LIMIT}.
            </Text>
            <View style={{ gap: 10, marginTop: 12 }}>
              {columns.map((column, index) => renderColumnCard({
                id: column.id,
                title: `Column ${index + 1}`,
                name: column.name,
                color: column.color,
                index,
                count: columns.length,
                onNameChange: (value) => update(column.id, "name", value),
                onColorChange: (value) => update(column.id, "color", value),
                onMove: (direction) => moveColumn(column.id, direction),
                onRemove: () => removeColumn(column.id),
              }))}
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
