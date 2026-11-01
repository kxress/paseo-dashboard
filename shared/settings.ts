import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_DASHBOARD_COLUMNS = [
  { id: "idle", name: "Idle", color: "#60a5fa" },
  { id: "custom-1", name: "Paused", color: "#a78bfa" },
  { id: "custom-2", name: "Unfiltered", color: "#94a3b8" },
] as const;

export const DASHBOARD_COLUMN_LIMIT = 13;
export const DEFAULT_ACTIVITY_COLUMN_NAMES = {
  unread: "Unread",
  "needs-attention": "Needs attention",
  running: "Running",
  idle: "Idle",
} as const;
export const DEFAULT_ACTIVITY_COLUMN_COLORS = {
  unread: "#4ade80",
  "needs-attention": "#facc15",
  running: "#22d3ee",
  idle: "#60a5fa",
} as const;

const dashboardColumnSchema = z.object({
  id: z.string().regex(/^(idle|custom-[a-z0-9-]+)$/),
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const dashboardViewSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(60),
  projectIds: z.array(z.string().trim().min(1)).max(500),
});

export type DashboardColumn = z.output<typeof dashboardColumnSchema>;
export type DashboardView = z.output<typeof dashboardViewSchema>;
export type ActivityColumnId = "unread" | "needs-attention" | "running";
export type ActivityColumnSettings = Record<ActivityColumnId, { name: string; color: string }>;
export const DEFAULT_ACTIVITY_COLUMN_ORDER: ActivityColumnId[] = ["unread", "needs-attention", "running"];
const activityColumnOrderSchema = z.array(z.enum(["unread", "needs-attention", "running"]))
  .length(3)
  .refine((order) => new Set(order).size === 3)
  .default(DEFAULT_ACTIVITY_COLUMN_ORDER);

const activityColumnSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
const activityColumnsSchema = z.object({
  unread: activityColumnSchema.default({ name: DEFAULT_ACTIVITY_COLUMN_NAMES.unread, color: DEFAULT_ACTIVITY_COLUMN_COLORS.unread }),
  "needs-attention": activityColumnSchema.default({ name: DEFAULT_ACTIVITY_COLUMN_NAMES["needs-attention"], color: DEFAULT_ACTIVITY_COLUMN_COLORS["needs-attention"] }),
  running: activityColumnSchema.default({ name: DEFAULT_ACTIVITY_COLUMN_NAMES.running, color: DEFAULT_ACTIVITY_COLUMN_COLORS.running }),
});

export const dashboardSettings = defineSettings({
  id: "dashboard",
  scope: "host",
  version: 2,
  schema: z.object({
    dashboardViews: z.array(dashboardViewSchema).default([]),
    customColumns: z.array(dashboardColumnSchema).min(1).max(DASHBOARD_COLUMN_LIMIT).default(
      DEFAULT_DASHBOARD_COLUMNS.map((column) => ({ ...column })),
    ),
    activityColumns: activityColumnsSchema.default({
      unread: { name: DEFAULT_ACTIVITY_COLUMN_NAMES.unread, color: DEFAULT_ACTIVITY_COLUMN_COLORS.unread },
      "needs-attention": { name: DEFAULT_ACTIVITY_COLUMN_NAMES["needs-attention"], color: DEFAULT_ACTIVITY_COLUMN_COLORS["needs-attention"] },
      running: { name: DEFAULT_ACTIVITY_COLUMN_NAMES.running, color: DEFAULT_ACTIVITY_COLUMN_COLORS.running },
    }),
    activityColumnOrder: activityColumnOrderSchema,
  }),
  migrate: (values, fromVersion) => {
    if (fromVersion !== 1 || !values || typeof values !== "object") return values;
    const record = values as Record<string, unknown>;
    const columns = Array.isArray(record.customColumns)
      ? record.customColumns as Array<Record<string, unknown>>
      : [];
    const hasIdle = columns.some((column) => column.id === "idle");
    return {
      ...record,
      customColumns: hasIdle
        ? columns
        : [{ ...DEFAULT_DASHBOARD_COLUMNS[0] }, ...columns].slice(0, DASHBOARD_COLUMN_LIMIT),
      activityColumns: {
        unread: { name: DEFAULT_ACTIVITY_COLUMN_NAMES.unread, color: DEFAULT_ACTIVITY_COLUMN_COLORS.unread },
        "needs-attention": { name: DEFAULT_ACTIVITY_COLUMN_NAMES["needs-attention"], color: DEFAULT_ACTIVITY_COLUMN_COLORS["needs-attention"] },
        running: { name: DEFAULT_ACTIVITY_COLUMN_NAMES.running, color: DEFAULT_ACTIVITY_COLUMN_COLORS.running },
      },
      activityColumnOrder: DEFAULT_ACTIVITY_COLUMN_ORDER,
    };
  },
});

export type ManualDashboardQueue = string;
export type DashboardWorkspaceOrder = Record<string, string[]>;

const workspaceQueueOverrideSchema = z.object({
  workspaceId: z.string().trim().min(1),
  queue: z.string().trim().min(1).max(80),
});

const dashboardWorkspaceOrderSchema = z
  .record(z.string(), z.array(z.string().trim().min(1)).max(10000))
  .default({});

export const dashboardOrganizationSettings = defineSettings({
  id: "dashboard-organization",
  scope: "host",
  version: 4,
  schema: z.object({
    workspaceQueueOverrides: z.array(workspaceQueueOverrideSchema).max(10000).default([]),
    workspaceOrder: dashboardWorkspaceOrderSchema,
  }),
  migrate: (values, fromVersion) => {
    if (!values || typeof values !== "object") return values;
    const record = values as Record<string, unknown>;
    if (fromVersion === 3) {
      const oldOverrides = Array.isArray(record.workspaceQueueOverrides)
        ? record.workspaceQueueOverrides as Array<Record<string, unknown>>
        : [];
      const workspaceQueueOverrides = oldOverrides.flatMap((override) => {
        if (typeof override.workspaceId !== "string") return [];
        const queue = override.queue === "paused" ? "custom-1"
          : override.queue === "unfiltered" ? "custom-2"
            : override.queue;
        return typeof queue === "string" ? [{ workspaceId: override.workspaceId, queue }] : [];
      });
      const oldOrder = record.workspaceOrder && typeof record.workspaceOrder === "object"
        ? record.workspaceOrder as Record<string, unknown>
        : {};
      const workspaceOrder: DashboardWorkspaceOrder = {};
      for (const [queue, id] of [["idle", "idle"], ["paused", "custom-1"], ["unfiltered", "custom-2"]]) {
        if (Array.isArray(oldOrder[queue])) workspaceOrder[id] = oldOrder[queue] as string[];
      }
      return { workspaceQueueOverrides, workspaceOrder };
    }
    if (fromVersion === 1) {
      const sideWorkspaceIds = Array.isArray(record.sideWorkspaceIds)
        ? record.sideWorkspaceIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
        : [];
      return {
        workspaceQueueOverrides: [...new Set(sideWorkspaceIds)].map((workspaceId) => ({
          workspaceId,
          queue: "custom-1",
        })),
        workspaceOrder: {},
      };
    }
    return values;
  },
});
