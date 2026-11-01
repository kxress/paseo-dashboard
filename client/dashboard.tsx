import type { PaseoAgent, PaseoProject, PaseoWorkspace } from "@getpaseo/client";
import type {
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { openExternalUrl, usePaseo, useSettings } from "@getpaseo/plugin/client";
import {
  Modal,
  ScrollView as PluginScrollView,
  TextInput,
} from "@getpaseo/plugin/client/react-native";
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, ScrollView, Text, View, type GestureResponderEvent, type ViewStyle } from "react-native";
import {
  dashboardOrganizationSettings,
  dashboardSettings,
  DEFAULT_ACTIVITY_COLUMN_COLORS,
  DEFAULT_ACTIVITY_COLUMN_NAMES,
  DEFAULT_DASHBOARD_COLUMNS,
  type DashboardView,
  type DashboardColumn,
  type ManualDashboardQueue,
  type DashboardWorkspaceOrder,
} from "../shared/settings";

const PAGE_SIZE = 200;
const BOARD_COLUMN_MIN_WIDTH = 276;
const BOARD_COLUMN_GAP = 8;
const BOARD_COLUMN_HEADER_HEIGHT = 38;
const BOARD_GROUP_GAP = 12;
const WORKSPACE_CARD_GAP = 9;
const MOBILE_DRAG_HOLD_MS = 500;
const BOARD_STACK_MIN_HEIGHT = 240;
const BOARD_GROUP_DECORATION_WIDTH = 12;
const BOARD_PADDING = 13;

type DashboardAgent = PaseoAgent & { background?: boolean };
type AttentionKind = "Permission" | "Question" | "Error";
type AutomaticQueueId = "unread" | "needs-attention" | "running" | "idle";
type QueueId = string;
type ActivityQueueId = "unread" | "needs-attention" | "running";

function isActivityQueue(queue: QueueId | undefined): queue is ActivityQueueId {
  return queue === "unread" || queue === "needs-attention" || queue === "running";
}

interface WorkspaceCardData {
  workspace: PaseoWorkspace;
  agents: DashboardAgent[];
  queue: QueueId;
  automaticQueue: AutomaticQueueId;
  attentionKinds: AttentionKind[];
  detail: string;
  isRunning: boolean;
}

interface DashboardData {
  workspaces: PaseoWorkspace[];
  agents: PaseoAgent[];
  projects: PaseoProject[];
}

interface Page<T> {
  entries: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

interface DropTarget {
  queue: ManualDashboardQueue;
  beforeWorkspaceId: string | null;
}

interface MeasuredView {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}

interface DropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  queue?: ManualDashboardQueue;
}

interface CardLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  queue?: QueueId;
}

interface DragPreview {
  workspaceId: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

interface ActivityFlight {
  workspaceId: string;
  width: number;
  height: number;
}

interface ActivityFlightMotion {
  position: Animated.ValueXY;
  arc: Animated.Value;
  opacity: Animated.Value;
  reveal: Animated.Value;
}

interface QueueArrival {
  queue: QueueId;
  sequence: number;
  recencyAtEntry: number;
}

async function allPages<T>(read: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const entries: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await read(cursor);
    entries.push(...page.entries);
    if (!page.pageInfo.hasMore) return entries;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next)) throw new Error("Workspace list pagination is incomplete.");
    seen.add(next);
    cursor = next;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectTitle(project: PaseoProject): string {
  return project.projectCustomName?.trim() || project.projectDisplayName || project.projectRootPath;
}

function formatActivityDate(value: string | null | undefined): string {
  if (!value) return "No activity date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No activity date";
  return `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}`;
}

function workspaceRecency(workspace: PaseoWorkspace): number {
  const activityAt = Date.parse(workspace.activityAt ?? "") || 0;
  const statusEnteredAt = Date.parse(workspace.statusEnteredAt ?? "") || 0;
  return Math.max(activityAt, statusEnteredAt);
}

function queueAfterManualOverride(
  automaticQueue: AutomaticQueueId,
  override: ManualDashboardQueue | undefined,
  manualQueues: readonly ManualDashboardQueue[],
): QueueId {
  if (automaticQueue === "unread" || automaticQueue === "needs-attention" || automaticQueue === "running")
    return automaticQueue;
  if (override && manualQueues.includes(override)) return override;
  if (automaticQueue === "idle" && !manualQueues.includes("idle")) return manualQueues[0] ?? automaticQueue;
  return automaticQueue;
}

function isVisibleAgent(agent: DashboardAgent): boolean {
  return !agent.archivedAt && !agent.internal && !agent.background;
}

function classifyWorkspace(
  workspace: PaseoWorkspace,
  agents: DashboardAgent[],
): WorkspaceCardData {
  const attentionKinds = new Set<AttentionKind>();
  let unread = false;
  let isRunning = workspace.status === "running";
  const detailParts: string[] = [];

  for (const agent of agents) {
    if (agent.status === "initializing" || agent.status === "running") isRunning = true;
    if (agent.status === "error") attentionKinds.add("Error");

    for (const permission of agent.pendingPermissions ?? []) {
      const kind = permission.kind === "question" ? "Question" : "Permission";
      attentionKinds.add(kind);
      const title = permission.title?.trim() || permission.name?.trim();
      if (title) detailParts.push(title);
    }

    if (agent.requiresAttention) {
      switch (agent.attentionReason) {
        case "permission":
          if (!(agent.pendingPermissions?.length)) attentionKinds.add("Permission");
          break;
        case "error":
          attentionKinds.add("Error");
          break;
        case "finished":
          unread = true;
          break;
        default:
          if (!agent.pendingPermissions?.length && agent.status !== "error") unread = true;
      }
    }

    if (agent.lastError && attentionKinds.has("Error")) detailParts.push(agent.lastError);
  }

  if (workspace.status === "failed") attentionKinds.add("Error");
  if (workspace.status === "needs_input" && !attentionKinds.has("Question"))
    attentionKinds.add("Permission");
  if (workspace.status === "attention") unread = true;

  const orderedKinds = (["Permission", "Question", "Error"] as const).filter((kind) =>
    attentionKinds.has(kind),
  );
  const queue: AutomaticQueueId = orderedKinds.length
    ? "needs-attention"
    : unread
      ? "unread"
        : isRunning
        ? "running"
        : "idle";

  const uniqueDetails = [...new Set(detailParts.map((part) => part.trim()).filter(Boolean))];
  const detail = orderedKinds.length
    ? uniqueDetails.slice(0, 2).join(" · ")
    : unread
      ? "Unread activity"
      : isRunning
      ? "Agent is running"
        : "No active or unread activity";

  return { workspace, agents, queue, automaticQueue: queue, attentionKinds: orderedKinds, detail, isRunning };
}

function workspaceQueues(
  data: DashboardData,
  queueOverrides: ReadonlyMap<string, ManualDashboardQueue>,
  manualQueues: readonly ManualDashboardQueue[],
): Map<string, QueueId> {
  const agentsByWorkspace = new Map<string, DashboardAgent[]>();
  for (const rawAgent of data.agents) {
    const agent = rawAgent as DashboardAgent;
    if (!agent.workspaceId || !isVisibleAgent(agent)) continue;
    const agents = agentsByWorkspace.get(agent.workspaceId) ?? [];
    agents.push(agent);
    agentsByWorkspace.set(agent.workspaceId, agents);
  }

  const queues = new Map<string, QueueId>();
  for (const workspace of data.workspaces) {
    if (workspace.internal || workspace.background || workspace.archivingAt) continue;
    const automaticQueue = classifyWorkspace(
      workspace,
      agentsByWorkspace.get(workspace.id) ?? [],
    ).automaticQueue;
    queues.set(workspace.id, queueAfterManualOverride(automaticQueue, queueOverrides.get(workspace.id), manualQueues));
  }
  return queues;
}

function queuesChanged(previous: ReadonlyMap<string, QueueId>, next: ReadonlyMap<string, QueueId>): boolean {
  if (previous.size !== next.size) return true;
  for (const [workspaceId, queue] of next) {
    if (previous.get(workspaceId) !== queue) return true;
  }
  return false;
}

async function measureCardLayouts(
  views: ReadonlyMap<string, MeasuredView>,
  queues?: ReadonlyMap<string, QueueId>,
): Promise<Map<string, CardLayout>> {
  const measurements = await Promise.all([...views].map(([workspaceId, view]) => new Promise<[string, CardLayout]>((resolve) => {
    view.measureInWindow((x, y, width, height) => {
      const queue = queues?.get(workspaceId);
      resolve([workspaceId, { x, y, width, height, ...(queue ? { queue } : {}) }]);
    });
  })));
  return new Map(measurements);
}

interface WorkspaceDragSurfaceProps {
  workspaceId: string;
  compact: boolean;
  disabled: boolean;
  children: ReactNode;
  onDragStart: (workspaceId: string, x: number, y: number) => void;
  onDragMove: (x: number, y: number) => void;
  onDrop: (workspaceId: string, x: number, y: number) => void;
  onDragCancel: (workspaceId: string) => void;
}

interface ActiveCardPointer {
  pointerId: number | string;
  startedAt: number;
  startX: number;
  startY: number;
  requiresHold: boolean;
  dragging: boolean;
}

interface PointerEventHost {
  addEventListener?: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void;
  removeEventListener?: (type: string, listener: EventListener, options?: boolean | EventListenerOptions) => void;
}

interface MobileQueueTab {
  id: QueueId;
  title: string;
  count: number;
  color: string;
}

interface MobileQueueTabsProps {
  activityTabs: MobileQueueTab[];
  organizationTabs: MobileQueueTab[];
  activeQueue: QueueId;
  isDragging: boolean;
  borderColor: string;
  foregroundColor: string;
  mutedColor: string;
  surfaceColor: string;
  activeSurfaceColor: string;
  onSelect: (queue: QueueId) => void;
}

function suppressNextWorkspaceClick(): void {
  if (typeof window === "undefined") return;
  let timeoutId: number | undefined;
  const onClick: EventListener = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    window.removeEventListener("click", onClick, true);
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  };
  window.addEventListener("click", onClick, true);
  timeoutId = window.setTimeout(() => window.removeEventListener("click", onClick, true), 0);
}

function WorkspaceDragSurface({
  workspaceId,
  compact,
  disabled,
  children,
  onDragStart,
  onDragMove,
  onDrop,
  onDragCancel,
}: WorkspaceDragSurfaceProps) {
  const surfaceRef = useRef<PointerEventHost | null>(null);
  const pointerRef = useRef<ActiveCardPointer | null>(null);
  const callbacksRef = useRef({ disabled, onDragStart, onDragMove, onDrop, onDragCancel });
  callbacksRef.current = { disabled, onDragStart, onDragMove, onDrop, onDragCancel };

  const beginOrMoveDrag = (pointerId: number | string, x: number, y: number, event: Event): void => {
    const active = pointerRef.current;
    if (!active || active.pointerId !== pointerId) return;
    if (callbacksRef.current.disabled) {
      pointerRef.current = null;
      if (active.dragging) callbacksRef.current.onDragCancel(workspaceId);
      return;
    }

    if (!active.dragging) {
      if (Math.abs(x - active.startX) + Math.abs(y - active.startY) <= 8) return;
      if (active.requiresHold && Date.now() - active.startedAt < MOBILE_DRAG_HOLD_MS) {
        pointerRef.current = null;
        return;
      }
      active.dragging = true;
      event.preventDefault();
      event.stopPropagation();
      callbacksRef.current.onDragStart(workspaceId, x, y);
    }

    event.preventDefault();
    event.stopPropagation();
    callbacksRef.current.onDragMove(x, y);
  };

  const finishDrag = (pointerId: number | string, x: number, y: number, event: Event): void => {
    const active = pointerRef.current;
    if (!active || active.pointerId !== pointerId) return;
    pointerRef.current = null;
    if (!active.dragging) return;
    suppressNextWorkspaceClick();
    event.preventDefault();
    event.stopPropagation();
    callbacksRef.current.onDrop(workspaceId, x, y);
  };

  const cancelDrag = (pointerId: number | string): void => {
    const active = pointerRef.current;
    if (!active || active.pointerId !== pointerId) return;
    pointerRef.current = null;
    if (active.dragging) callbacksRef.current.onDragCancel(workspaceId);
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "touch" || callbacksRef.current.disabled || pointerRef.current || !event.isPrimary || event.button !== 0) return;
    pointerRef.current = {
      pointerId: event.pointerId,
      startedAt: Date.now(),
      startX: event.clientX,
      startY: event.clientY,
      requiresHold: compact && event.pointerType !== "mouse",
      dragging: false,
    };
  };
  const handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") beginOrMoveDrag(event.pointerId, event.clientX, event.clientY, event);
  };
  const handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") finishDrag(event.pointerId, event.clientX, event.clientY, event);
  };
  const handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") cancelDrag(event.pointerId);
  };

  const handleTouchStart = (event: TouchEvent): void => {
    if (callbacksRef.current.disabled || pointerRef.current) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    pointerRef.current = {
      pointerId: touch.identifier,
      startedAt: Date.now(),
      startX: touch.clientX,
      startY: touch.clientY,
      requiresHold: true,
      dragging: false,
    };
  };
  const handleTouchMove = (event: TouchEvent): void => {
    const active = pointerRef.current;
    const touch = active && Array.from(event.changedTouches).find((candidate) => candidate.identifier === active.pointerId);
    if (active && touch) beginOrMoveDrag(active.pointerId, touch.clientX, touch.clientY, event);
  };
  const handleTouchEnd = (event: TouchEvent): void => {
    const active = pointerRef.current;
    const touch = active && Array.from(event.changedTouches).find((candidate) => candidate.identifier === active.pointerId);
    if (active && touch) finishDrag(active.pointerId, touch.clientX, touch.clientY, event);
  };
  const handleTouchCancel = (event: TouchEvent): void => {
    const active = pointerRef.current;
    const touch = active && Array.from(event.changedTouches).find((candidate) => candidate.identifier === active.pointerId);
    if (active && touch) cancelDrag(active.pointerId);
  };

  const handleNativeTouchStart = (event: GestureResponderEvent): void => {
    if (typeof surfaceRef.current?.addEventListener === "function") return;
    if (callbacksRef.current.disabled || pointerRef.current) return;
    const touch = event.nativeEvent;
    pointerRef.current = {
      pointerId: touch.identifier,
      startedAt: Date.now(),
      startX: touch.pageX,
      startY: touch.pageY,
      requiresHold: true,
      dragging: false,
    };
  };

  const shouldClaimNativeTouch = (event: GestureResponderEvent): boolean => {
    if (typeof surfaceRef.current?.addEventListener === "function") return false;
    const active = pointerRef.current;
    if (!active || active.dragging || callbacksRef.current.disabled) return false;
    const { pageX, pageY } = event.nativeEvent;
    if (Math.abs(pageX - active.startX) + Math.abs(pageY - active.startY) <= 8) return false;
    if (active.requiresHold && Date.now() - active.startedAt < MOBILE_DRAG_HOLD_MS) {
      pointerRef.current = null;
      return false;
    }
    return true;
  };

  const handleNativeResponderGrant = (event: GestureResponderEvent): void => {
    const active = pointerRef.current;
    if (!active || callbacksRef.current.disabled) return;
    active.dragging = true;
    callbacksRef.current.onDragStart(workspaceId, event.nativeEvent.pageX, event.nativeEvent.pageY);
  };

  const handleNativeResponderMove = (event: GestureResponderEvent): void => {
    const active = pointerRef.current;
    if (!active?.dragging) return;
    callbacksRef.current.onDragMove(event.nativeEvent.pageX, event.nativeEvent.pageY);
  };

  const handleNativeResponderRelease = (event: GestureResponderEvent): void => {
    const active = pointerRef.current;
    pointerRef.current = null;
    if (!active?.dragging) return;
    suppressNextWorkspaceClick();
    callbacksRef.current.onDrop(workspaceId, event.nativeEvent.pageX, event.nativeEvent.pageY);
  };

  const handleNativeResponderTerminate = (): void => {
    const active = pointerRef.current;
    pointerRef.current = null;
    if (active?.dragging) callbacksRef.current.onDragCancel(workspaceId);
  };

  const handleNativeTouchEnd = (): void => {
    if (pointerRef.current && !pointerRef.current.dragging) pointerRef.current = null;
  };

  const eventHandlersRef = useRef({
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
  });
  eventHandlersRef.current = {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
  };

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface?.addEventListener || !surface.removeEventListener || typeof window === "undefined") return;

    const onPointerMove: EventListener = (event) => eventHandlersRef.current.handlePointerMove(event as PointerEvent);
    const onPointerUp: EventListener = (event) => {
      eventHandlersRef.current.handlePointerUp(event as PointerEvent);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
    };
    const onPointerCancel: EventListener = (event) => {
      eventHandlersRef.current.handlePointerCancel(event as PointerEvent);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
    };
    const onPointerDown: EventListener = (event) => {
      eventHandlersRef.current.handlePointerDown(event as PointerEvent);
      if (!pointerRef.current) return;
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerCancel, true);
    };

    const onTouchMove: EventListener = (event) => eventHandlersRef.current.handleTouchMove(event as TouchEvent);
    const onTouchEnd: EventListener = (event) => {
      eventHandlersRef.current.handleTouchEnd(event as TouchEvent);
      window.removeEventListener("touchmove", onTouchMove, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchCancel, true);
    };
    const onTouchCancel: EventListener = (event) => {
      eventHandlersRef.current.handleTouchCancel(event as TouchEvent);
      window.removeEventListener("touchmove", onTouchMove, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchCancel, true);
    };
    const onTouchStart: EventListener = (event) => {
      eventHandlersRef.current.handleTouchStart(event as TouchEvent);
      if (!pointerRef.current) return;
      window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
      window.addEventListener("touchend", onTouchEnd, true);
      window.addEventListener("touchcancel", onTouchCancel, true);
    };

    surface.addEventListener("pointerdown", onPointerDown, true);
    surface.addEventListener("touchstart", onTouchStart, true);
    return () => {
      surface.removeEventListener?.("pointerdown", onPointerDown, true);
      surface.removeEventListener?.("touchstart", onTouchStart, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("touchmove", onTouchMove, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchCancel, true);
      pointerRef.current = null;
    };
  }, []);

  return (
    <View
      ref={(view) => { surfaceRef.current = view as unknown as PointerEventHost | null; }}
      onTouchStart={handleNativeTouchStart}
      onTouchEnd={handleNativeTouchEnd}
      onTouchCancel={handleNativeTouchEnd}
      onMoveShouldSetResponder={shouldClaimNativeTouch}
      onResponderGrant={handleNativeResponderGrant}
      onResponderMove={handleNativeResponderMove}
      onResponderRelease={handleNativeResponderRelease}
      onResponderTerminate={handleNativeResponderTerminate}
      onResponderTerminationRequest={() => !pointerRef.current?.dragging}
      style={{
        gap: 4,
        cursor: disabled || compact ? "auto" : "pointer",
        userSelect: "none",
      } as ViewStyle & { userSelect: "none" }}
    >
      {children}
    </View>
  );
}

function MobileQueueTabs({
  activityTabs,
  organizationTabs,
  activeQueue,
  isDragging,
  borderColor,
  foregroundColor,
  mutedColor,
  surfaceColor,
  activeSurfaceColor,
  onSelect,
}: MobileQueueTabsProps) {
  const rootRef = useRef<PointerEventHost | null>(null);
  const callbacksRef = useRef({ activityTabs, organizationTabs, onSelect });
  callbacksRef.current = { activityTabs, organizationTabs, onSelect };

  const queueAtPoint = (x: number, y: number): QueueId | null => {
    if (typeof document === "undefined") return null;
    const target = document.elementFromPoint(x, y);
    if (!(target instanceof Element)) return null;
    const tab = target.closest<HTMLElement>("[id^='agent-dashboard-tab-']");
    if (!tab) return null;
    const queue = tab.id.slice("agent-dashboard-tab-".length) as QueueId;
    const tabs = [...callbacksRef.current.activityTabs, ...callbacksRef.current.organizationTabs];
    return tabs.some((candidate) => candidate.id === queue) ? queue : null;
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root?.addEventListener || !root.removeEventListener || typeof window === "undefined") return;

    const selectAtPoint = (x: number, y: number): void => {
      const queue = queueAtPoint(x, y);
      if (queue) callbacksRef.current.onSelect(queue);
    };
    const onPointerMove: EventListener = (event) => {
      const pointer = event as PointerEvent;
      if (pointer.pointerType === "mouse" && pointer.buttons === 0) selectAtPoint(pointer.clientX, pointer.clientY);
    };
    const onTouchStart: EventListener = (event) => {
      const touch = (event as TouchEvent).changedTouches[0];
      if (touch) selectAtPoint(touch.clientX, touch.clientY);
    };
    const onTouchMove: EventListener = (event) => {
      for (const touch of Array.from((event as TouchEvent).changedTouches)) {
        selectAtPoint(touch.clientX, touch.clientY);
      }
    };
    const onDraggingPointerMove: EventListener = (event) => {
      const pointer = event as PointerEvent;
      selectAtPoint(pointer.clientX, pointer.clientY);
    };

    root.addEventListener("pointermove", onPointerMove, true);
    root.addEventListener("touchstart", onTouchStart, true);
    root.addEventListener("touchmove", onTouchMove, true);
    if (isDragging) {
      window.addEventListener("pointermove", onDraggingPointerMove, true);
      window.addEventListener("touchmove", onTouchMove, true);
    }
    return () => {
      root.removeEventListener?.("pointermove", onPointerMove, true);
      root.removeEventListener?.("touchstart", onTouchStart, true);
      root.removeEventListener?.("touchmove", onTouchMove, true);
      window.removeEventListener("pointermove", onDraggingPointerMove, true);
      window.removeEventListener("touchmove", onTouchMove, true);
    };
  }, [isDragging]);

  const renderGroup = (title: string, tabs: MobileQueueTab[], separated: boolean) => (
    <View style={{ gap: 4, ...(separated ? { borderTopWidth: 1, borderTopColor: borderColor, paddingTop: 7 } : {}) }}>
      <Text style={{ color: mutedColor, fontSize: 9, fontWeight: "700", letterSpacing: 0.7 }}>{title}</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {tabs.map((tab) => {
          const selected = activeQueue === tab.id;
          return (
            <Pressable
              key={tab.id}
              nativeID={`agent-dashboard-tab-${tab.id}`}
              accessibilityLabel={`${tab.title}, ${tab.count} workspaces`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onSelect(tab.id)}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 34,
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 6,
                borderWidth: 1,
                borderColor: selected ? tab.color : borderColor,
                borderRadius: 7,
                backgroundColor: selected ? activeSurfaceColor : surfaceColor,
              }}
            >
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tab.color }} />
              <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: selected ? foregroundColor : mutedColor, fontSize: 10, fontWeight: selected ? "700" : "500" }}>
                {tab.title}
              </Text>
              <Text style={{ color: selected ? foregroundColor : mutedColor, fontSize: 9 }}>{tab.count}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  return (
    <View ref={(view) => { rootRef.current = view as unknown as PointerEventHost | null; }} style={{ gap: 7 }}>
      {renderGroup("AGENT ACTIVITY", activityTabs, false)}
      {renderGroup("WORKSPACE ORGANIZATION", organizationTabs, true)}
    </View>
  );
}
export function AgentDashboardSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="LayoutDashboard"
      label="Paseo Dashboard"
      active={currentScreen?.screenId === "dashboard"}
      onPress={() => openScreen({ screenId: "dashboard" })}
    />
  );
}

export function AgentDashboard({ theme, layout, host, navigation, params }: PluginScreenProps) {
  const paseo = usePaseo();
  const settings = useSettings(dashboardSettings);
  const organizationSettings = useSettings(dashboardOrganizationSettings);
  const [data, setData] = useState<DashboardData | null>(null);
  const [queueArrivals, setQueueArrivals] = useState<ReadonlyMap<string, QueueArrival>>(() => new Map());
  const [loadError, setLoadError] = useState("");
  const [connectionWarning, setConnectionWarning] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [boardViewportWidth, setBoardViewportWidth] = useState(0);
  const [boardViewportHeight, setBoardViewportHeight] = useState(0);
  const [mobileActiveQueue, setMobileActiveQueue] = useState<QueueId | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedViewId, setSelectedViewId] = useState(params.viewId ?? "");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [viewPickerLeft, setViewPickerLeft] = useState(0);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingViewId, setEditingViewId] = useState<string | null>(null);
  const [viewNameDraft, setViewNameDraft] = useState("");
  const [viewProjectIds, setViewProjectIds] = useState<string[]>([]);
  const [projectSearch, setProjectSearch] = useState("");
  const [viewError, setViewError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [manualQueueOverrideDrafts, setManualQueueOverrideDrafts] = useState<Record<string, ManualDashboardQueue>>({});
  const [manualWorkspaceOrderDrafts, setManualWorkspaceOrderDrafts] = useState<DashboardWorkspaceOrder | null>(null);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [dropLandingWorkspaceId, setDropLandingWorkspaceId] = useState<string | null>(null);
  const [activityFlights, setActivityFlights] = useState<ActivityFlight[]>([]);
  const [activityFlightWorkspaceIds, setActivityFlightWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [animatingWorkspaceIds, setAnimatingWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const mobileActiveQueueRef = useRef<QueueId>("unread");
  const draggedWorkspaceIdRef = useRef<string | null>(null);
  const dropLandingWorkspaceIdRef = useRef<string | null>(null);
  const dropLandingAnimationStartedRef = useRef(false);
  const dragPreviewRef = useRef<DragPreview | null>(null);
  const dragPreviewMotion = useMemo(() => new Animated.ValueXY({ x: 0, y: 0 }), []);
  const dragPreviewTilt = useMemo(() => new Animated.Value(0), []);
  const dragPreviewLift = useMemo(() => new Animated.Value(0), []);
  const dragPreviewOpacity = useMemo(() => new Animated.Value(0.96), []);
  const dropLandingReveal = useMemo(() => new Animated.Value(1), []);
  const dragPreviewLiftAnimatingRef = useRef(false);
  const dragPreviewTargetRef = useRef<{ x: number; y: number } | null>(null);
  const boardViewRef = useRef<MeasuredView | null>(null);
  const boardWindowOriginRef = useRef({ x: 0, y: 0 });
  const cardQueuesRef = useRef<Map<string, QueueId> | null>(null);
  const cardAutomaticQueuesRef = useRef<Map<string, QueueId> | null>(null);
  const queueArrivalSequenceRef = useRef(0);
  const manualQueuesRef = useRef<readonly ManualDashboardQueue[]>(["idle"]);
  const queueOverridesRef = useRef<ReadonlyMap<string, ManualDashboardQueue>>(new Map());
  const cardMotionRefs = useRef(new Map<string, MeasuredView>());
  const cardMotionValues = useRef(new Map<string, Animated.ValueXY>());
  const cardArcValues = useRef(new Map<string, Animated.Value>());
  const activityFlightMotionsRef = useRef(new Map<string, ActivityFlightMotion>());
  const cardMotionRefCallbacks = useRef(new Map<string, (view: unknown) => void>());
  const pendingCardLayoutsRef = useRef<Map<string, CardLayout> | null>(null);
  const dropZoneRefs = useRef<Partial<Record<ManualDashboardQueue, MeasuredView>>>({});
  const dropZoneRects = useRef<Partial<Record<ManualDashboardQueue, DropRect>>>({});
  const cardDropRefs = useRef(new Map<string, MeasuredView>());
  const cardDropQueues = useRef(new Map<string, ManualDashboardQueue>());
  const cardDropRects = useRef(new Map<string, DropRect>());
  const cardDropRefCallbacks = useRef(new Map<string, (view: MeasuredView | null) => void>());

  useEffect(() => {
    setSelectedViewId(params.viewId ?? "");
  }, [params.viewId]);

  useEffect(() => {
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let isRefreshing = false;
    let refreshAgain = false;
    const releases: Array<() => unknown> = [];

    const refresh = async (): Promise<void> => {
      if (isRefreshing) {
        refreshAgain = true;
        return;
      }
      isRefreshing = true;
      setRefreshing(true);
      try {
        do {
          refreshAgain = false;
          const [workspaces, agentEntries, projectResult] = await Promise.all([
            allPages((cursor) =>
              paseo.workspaces.list({
                page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
              }),
            ),
            allPages((cursor) =>
              paseo.agents.list({
                filter: { includeArchived: true },
                page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
              }),
            ),
            paseo.projects.list(),
          ]);
          if (!active) return;
          const nextData = {
            workspaces,
            agents: agentEntries.map((entry) => entry.agent),
            projects: projectResult.projects,
          };
          const nextQueues = workspaceQueues(
            nextData,
            queueOverridesRef.current,
            manualQueuesRef.current,
          );
          const nextAutomaticQueues = workspaceQueues(
            nextData,
            new Map(),
            manualQueuesRef.current,
          );
          const previousQueues = cardQueuesRef.current;
          const previousAutomaticQueues = cardAutomaticQueuesRef.current;
          if (previousQueues && previousAutomaticQueues) {
            const arrivals = new Map<string, QueueArrival>();
            const workspacesById = new Map(nextData.workspaces.map((workspace) => [workspace.id, workspace]));
            for (const [workspaceId, queue] of nextQueues) {
              const previousQueue = previousQueues.get(workspaceId);
              const previousAutomaticQueue = previousAutomaticQueues.get(workspaceId);
              const automaticQueue = nextAutomaticQueues.get(workspaceId);
              const workspace = workspacesById.get(workspaceId);
              if (!previousQueue || previousQueue === queue || !workspace
                || !previousAutomaticQueue || previousAutomaticQueue === automaticQueue
                || queue !== automaticQueue) continue;
              arrivals.set(workspaceId, {
                queue,
                sequence: ++queueArrivalSequenceRef.current,
                recencyAtEntry: workspaceRecency(workspace),
              });
            }
            if (arrivals.size) {
              setQueueArrivals((current) => {
                const next = new Map(current);
                for (const [workspaceId, arrival] of arrivals) next.set(workspaceId, arrival);
                return next;
              });
            }
          }
          if (cardQueuesRef.current && queuesChanged(cardQueuesRef.current, nextQueues)) {
            pendingCardLayoutsRef.current = await measureCardLayouts(cardMotionRefs.current, cardQueuesRef.current);
            if (!active) return;
          }
          cardQueuesRef.current = nextQueues;
          cardAutomaticQueuesRef.current = nextAutomaticQueues;
          setData(nextData);
          setLoadError("");
        } while (refreshAgain && active);
      } catch (error) {
        if (active) setLoadError(errorMessage(error));
      } finally {
        isRefreshing = false;
        if (active) setRefreshing(false);
      }
    };

    const scheduleRefresh = (): void => {
      if (!active) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 200);
    };

    const attachSubscriptions = async (): Promise<void> => {
      try {
        const workspaces = await paseo.workspaces.list({
          page: { limit: PAGE_SIZE },
          subscribe: {},
        });
        if (!active) {
          await workspaces.subscription.release();
          return;
        }
        releases.push(() => workspaces.subscription.release());
        workspaces.subscription.subscribe({
          snapshot: scheduleRefresh,
          update: scheduleRefresh,
          error: () => {
            if (active) setConnectionWarning("Live workspace updates disconnected.");
          },
        });

        const agents = await paseo.agents.list({
          filter: { includeArchived: true },
          page: { limit: PAGE_SIZE },
          subscribe: {},
        });
        if (!active) {
          await agents.subscription.release();
          return;
        }
        releases.push(() => agents.subscription.release());
        agents.subscription.subscribe({
          snapshot: scheduleRefresh,
          update: scheduleRefresh,
          error: () => {
            if (active) setConnectionWarning("Live agent updates disconnected.");
          },
        });

        const subagents = paseo.observeEvents(["agent.provider_subagents.update"]);
        if (!active) {
          await subagents.release();
          return;
        }
        releases.push(() => subagents.release());
        subagents.subscribe({
          snapshot: scheduleRefresh,
          update: scheduleRefresh,
          error: () => {
            if (active) setConnectionWarning("Live agent updates disconnected.");
          },
        });
        releases.push(paseo.projects.subscribe(scheduleRefresh));

        await Promise.all([
          workspaces.subscription.ready,
          agents.subscription.ready,
          subagents.ready,
        ]);
        if (active) {
          setConnectionWarning("");
          scheduleRefresh();
        }
      } catch (error) {
        if (active) setConnectionWarning(`Live updates unavailable: ${errorMessage(error)}`);
      }
    };

    void refresh();
    void attachSubscriptions();
    return () => {
      active = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      void Promise.allSettled(releases.map((release) => Promise.resolve(release())));
    };
  }, [paseo, reloadKey]);

  const customColumns: DashboardColumn[] = settings.status === "ready"
    ? settings.values.customColumns
    : DEFAULT_DASHBOARD_COLUMNS.map((column) => ({ ...column }));
  const customColumnsKey = JSON.stringify(customColumns);
  const manualQueues = useMemo(
    () => customColumns.map((column) => column.id),
    [customColumnsKey],
  );
  manualQueuesRef.current = manualQueues;
  const persistedQueueOverrides = organizationSettings.status === "ready"
    ? organizationSettings.values.workspaceQueueOverrides
    : [];
  const persistedQueueOverridesKey = JSON.stringify(persistedQueueOverrides);
  const persistedQueueOverrideMap = useMemo(
    () => new Map(persistedQueueOverrides.map(({ workspaceId, queue }) => [workspaceId, queue])),
    [persistedQueueOverridesKey],
  );
  const queueOverrideMap = useMemo(() => {
    const overrides = new Map(persistedQueueOverrideMap);
    for (const [workspaceId, queue] of Object.entries(manualQueueOverrideDrafts))
      overrides.set(workspaceId, queue);
    return overrides;
  }, [manualQueueOverrideDrafts, persistedQueueOverrideMap]);
  queueOverridesRef.current = queueOverrideMap;
  const persistedWorkspaceOrder = organizationSettings.status === "ready"
    ? organizationSettings.values.workspaceOrder
    : {};
  const persistedWorkspaceOrderKey = JSON.stringify(persistedWorkspaceOrder);
  const workspaceOrder = manualWorkspaceOrderDrafts ?? persistedWorkspaceOrder;
  const workspaceOrderKey = JSON.stringify(workspaceOrder);
  const workspaceOrderIndices = useMemo(() => {
    const indices = {} as Record<ManualDashboardQueue, Map<string, number>>;
    for (const queue of manualQueues) {
      indices[queue] = new Map((workspaceOrder[queue] ?? []).map((workspaceId, index) => [workspaceId, index]));
    }
    return indices;
  }, [workspaceOrderKey, customColumns]);
  useEffect(() => {
    if (organizationSettings.status !== "ready") return;
    setManualQueueOverrideDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const [workspaceId, queue] of Object.entries(current)) {
        if (persistedQueueOverrideMap.get(workspaceId) === queue) {
          delete next[workspaceId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [organizationSettings.status, persistedQueueOverridesKey, persistedQueueOverrideMap]);
  useEffect(() => {
    if (organizationSettings.status !== "ready") return;
    setManualWorkspaceOrderDrafts((current) =>
      current && JSON.stringify(current) === persistedWorkspaceOrderKey ? null : current,
    );
  }, [organizationSettings.status, persistedWorkspaceOrderKey]);
  const savedViews = settings.status === "ready" ? settings.values.dashboardViews : [];
  const activitySettings = settings.status === "ready"
    ? settings.values.activityColumns
    : {
      unread: { name: DEFAULT_ACTIVITY_COLUMN_NAMES.unread, color: DEFAULT_ACTIVITY_COLUMN_COLORS.unread },
      "needs-attention": { name: DEFAULT_ACTIVITY_COLUMN_NAMES["needs-attention"], color: DEFAULT_ACTIVITY_COLUMN_COLORS["needs-attention"] },
      running: { name: DEFAULT_ACTIVITY_COLUMN_NAMES.running, color: DEFAULT_ACTIVITY_COLUMN_COLORS.running },
    };
  const activityColumnOrder = settings.status === "ready"
    ? settings.values.activityColumnOrder
    : ["unread", "needs-attention", "running"] as const;
  const columnNames: Record<QueueId, string> = {
    ...DEFAULT_ACTIVITY_COLUMN_NAMES,
    ...Object.fromEntries(Object.entries(activitySettings).map(([id, column]) => [id, column.name])),
    ...Object.fromEntries(customColumns.map((column) => [column.id, column.name])),
  };
  const columnColors: Record<QueueId, string> = {
    ...DEFAULT_ACTIVITY_COLUMN_COLORS,
    ...Object.fromEntries(Object.entries(activitySettings).map(([id, column]) => [id, column.color])),
    ...Object.fromEntries(customColumns.map((column) => [column.id, column.color])),
  };
  const activeView = savedViews.find((view) => view.id === selectedViewId);
  const activeProjectIds = activeView ? new Set(activeView.projectIds) : null;

  const grouped = useMemo(() => {
    const cards: WorkspaceCardData[] = [];
    const agentMap = new Map<string, DashboardAgent[]>();
    for (const rawAgent of data?.agents ?? []) {
      const agent = rawAgent as DashboardAgent;
      if (!agent.workspaceId || !isVisibleAgent(agent)) continue;
      const current = agentMap.get(agent.workspaceId) ?? [];
      current.push(agent);
      agentMap.set(agent.workspaceId, current);
    }

    const projectNames = new Map((data?.projects ?? []).map((project) => [project.projectId, projectTitle(project)]));
    const query = search.trim().toLocaleLowerCase();
    for (const workspace of data?.workspaces ?? []) {
      if (workspace.internal || workspace.background || workspace.archivingAt) continue;
      if (activeProjectIds && !activeProjectIds.has(workspace.projectId)) continue;
      const agents = agentMap.get(workspace.id) ?? [];
      const projectName = projectNames.get(workspace.projectId) ?? workspace.projectDisplayName;
      if (query) {
        const searchText = [
          workspace.title,
          workspace.name,
          projectName,
          workspace.projectRootPath,
          ...agents.flatMap((agent) => [agent.title, agent.provider, agent.model]),
        ].filter(Boolean).join(" ").toLocaleLowerCase();
        if (!searchText.includes(query)) continue;
      }
      const card = classifyWorkspace(workspace, agents);
      cards.push({
        ...card,
        queue: queueAfterManualOverride(card.automaticQueue, queueOverrideMap.get(workspace.id), manualQueues),
      });
    }
    cards.sort((left, right) => {
      return workspaceRecency(right.workspace) - workspaceRecency(left.workspace);
    });

    const arrivalSequence = (card: WorkspaceCardData): number | undefined => {
      const arrival = queueArrivals.get(card.workspace.id);
      if (arrival?.queue !== card.queue || workspaceRecency(card.workspace) > arrival.recencyAtEntry)
        return undefined;
      return arrival.sequence;
    };
    const compareArrival = (left: WorkspaceCardData, right: WorkspaceCardData): number => {
      const leftArrival = arrivalSequence(left);
      const rightArrival = arrivalSequence(right);
      if (leftArrival === undefined && rightArrival === undefined) return 0;
      if (leftArrival === undefined) return 1;
      if (rightArrival === undefined) return -1;
      return rightArrival - leftArrival;
    };
    const orderedActivityQueue = (queue: ActivityQueueId): WorkspaceCardData[] =>
      cards.filter((card) => card.queue === queue).sort((left, right) =>
        compareArrival(left, right) || workspaceRecency(right.workspace) - workspaceRecency(left.workspace),
      );
    const orderedQueue = (queue: ManualDashboardQueue): WorkspaceCardData[] => {
      const positions = workspaceOrderIndices[queue];
      return cards.filter((card) => card.queue === queue).sort((left, right) => {
        const arrivalOrder = compareArrival(left, right);
        if (arrivalOrder) return arrivalOrder;
        const leftPosition = positions.get(left.workspace.id);
        const rightPosition = positions.get(right.workspace.id);
        if (leftPosition !== undefined && rightPosition !== undefined) return leftPosition - rightPosition;
        if (leftPosition !== undefined) return -1;
        if (rightPosition !== undefined) return 1;
        return workspaceRecency(right.workspace) - workspaceRecency(left.workspace);
      });
    };

    const groupedColumns: Record<string, WorkspaceCardData[]> = {};
    for (const queue of manualQueues) groupedColumns[queue] = orderedQueue(queue);
    return {
      unread: orderedActivityQueue("unread"),
      needsAttention: orderedActivityQueue("needs-attention"),
      running: orderedActivityQueue("running"),
      ...groupedColumns,
      total: cards.length,
    } as Record<string, WorkspaceCardData[]> & { unread: WorkspaceCardData[]; needsAttention: WorkspaceCardData[]; running: WorkspaceCardData[]; total: number };
  }, [activeProjectIds, data, search, queueArrivals, queueOverrideMap, workspaceOrderIndices, manualQueues]);

  const queueEntries: Array<[QueueId, WorkspaceCardData[]]> = [
    ["unread", grouped.unread],
    ["needs-attention", grouped.needsAttention],
    ["running", grouped.running],
    ...manualQueues.map((queue): [QueueId, WorkspaceCardData[]] => [queue, grouped[queue] as WorkspaceCardData[]]),
  ];
  const firstPopulatedQueue: QueueId = queueEntries.find(([, cards]) => cards.length > 0)?.[0] ?? "unread";
  useEffect(() => {
    if (mobileActiveQueue && !queueEntries.some(([queue]) => queue === mobileActiveQueue))
      setMobileActiveQueue(null);
  }, [mobileActiveQueue, manualQueues]);
  const activeMobileQueue = mobileActiveQueue ?? firstPopulatedQueue;
  mobileActiveQueueRef.current = activeMobileQueue;
  const selectMobileQueue = (queue: QueueId): void => {
    if (mobileActiveQueueRef.current === queue) return;
    mobileActiveQueueRef.current = queue;
    setMobileActiveQueue(queue);
    setDropTarget(null);
  };

  const currentQueueByWorkspace = useMemo(() => {
    const queues = new Map<string, QueueId>();
    for (const card of grouped.unread) queues.set(card.workspace.id, "unread");
    for (const card of grouped.needsAttention) queues.set(card.workspace.id, "needs-attention");
    for (const card of grouped.running) queues.set(card.workspace.id, "running");
    for (const queue of manualQueues) {
      for (const card of grouped[queue] as WorkspaceCardData[]) queues.set(card.workspace.id, queue);
    }
    return queues;
  }, [grouped, manualQueues]);

  const colors = theme.colors;
  const compact = layout.compact;
  const boardPadding = compact ? 10 : BOARD_PADDING;
  const stackedGroupMinHeight = compact ? 280 : BOARD_STACK_MIN_HEIGHT;
  const availableGroupWidth = Math.max(0, (boardViewportWidth - boardPadding * 2 - BOARD_GROUP_GAP) / 2);
  const responsiveColumnMinWidth = Math.max(160, Math.min(
    BOARD_COLUMN_MIN_WIDTH,
    Math.floor(Math.min(
      (availableGroupWidth - BOARD_COLUMN_GAP * 2) / 3,
      (availableGroupWidth - BOARD_GROUP_DECORATION_WIDTH - BOARD_COLUMN_GAP * (customColumns.length - 1)) / customColumns.length,
    )),
  ));
  const activityGroupMinWidth = responsiveColumnMinWidth * 3 + BOARD_COLUMN_GAP * 2;
  const organizationGroupMinWidth = Math.max(
    activityGroupMinWidth,
    customColumns.length * responsiveColumnMinWidth + Math.max(0, customColumns.length - 1) * BOARD_COLUMN_GAP,
  );
  const stackBoardGroups = boardViewportWidth
    < BOARD_COLUMN_MIN_WIDTH * 3 + BOARD_COLUMN_GAP * 2 + BOARD_GROUP_DECORATION_WIDTH + boardPadding * 2;
  const compactStackBoardGroups = compact && stackBoardGroups;
  const agentActivityGroupHeight = compactStackBoardGroups && boardViewportHeight > 0
    ? boardViewportHeight * 0.5
    : stackedGroupMinHeight;
  const organizationGroupHeight = compactStackBoardGroups && boardViewportHeight > 0
    ? boardViewportHeight * 1.5
    : stackedGroupMinHeight;
  const stackedBoardGroupsHeight = stackBoardGroups
    ? agentActivityGroupHeight + organizationGroupHeight + BOARD_GROUP_GAP
    : 0;
  const stackedBoardScrollHeight = stackedBoardGroupsHeight + boardPadding * 2;
  const minimumBoardInnerWidth = stackBoardGroups
    ? Math.max(activityGroupMinWidth, organizationGroupMinWidth)
    : activityGroupMinWidth + organizationGroupMinWidth + BOARD_GROUP_GAP + BOARD_GROUP_DECORATION_WIDTH;
  const boardScrollContentWidth = Math.max(boardViewportWidth, minimumBoardInnerWidth + boardPadding * 2);
  const styles = useMemo(() => ({
    root: { flex: 1, minHeight: 0, backgroundColor: colors.surface0 },
    header: {
      paddingHorizontal: compact ? 12 : 20,
      paddingTop: compact ? 12 : 15,
      paddingBottom: 11,
      gap: 11,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    headingRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: compact ? ("wrap" as const) : ("nowrap" as const),
      gap: 9,
    },
    heading: { color: colors.foreground, fontSize: 14, fontWeight: "700" as const },
    total: { color: colors.foregroundMuted, fontSize: 11 },
    headerActions: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 6,
      marginLeft: compact ? 0 : ("auto" as const),
    },
    iconButton: {
      minWidth: 30,
      minHeight: 28,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      backgroundColor: colors.surface1,
    },
    buttonText: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    toolbar: { flexDirection: compact ? ("column" as const) : ("row" as const), gap: 7 },
    searchBox: {
      flex: 1,
      minHeight: 31,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 7,
      paddingHorizontal: 9,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 7,
      backgroundColor: colors.surface1,
    },
    searchIcon: { color: colors.foregroundMuted, fontSize: 14 },
    searchInput: { flex: 1, minWidth: 0, color: colors.foreground, fontSize: 12, paddingVertical: 5 },
    searchHint: { color: colors.foregroundMuted, fontSize: 10 },
    viewPickerWrap: {},
    viewPickerButton: {
      minHeight: 28,
      maxWidth: 230,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 9,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      backgroundColor: colors.surface1,
    },
    viewPickerLabel: { color: colors.foreground, fontSize: 11, flexShrink: 1 },
    viewMenu: {
      position: "absolute" as const,
      zIndex: 1000,
      elevation: 1000,
      minWidth: 230,
      maxWidth: compact ? 280 : 360,
      padding: 5,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface1,
    },
    viewMenuHeading: { color: colors.foregroundMuted, fontSize: 9, fontWeight: "700" as const, paddingHorizontal: 8, paddingVertical: 6 },
    viewMenuOption: { minHeight: 30, justifyContent: "center" as const, paddingHorizontal: 8, borderRadius: 5 },
    viewMenuOptionSelected: { backgroundColor: colors.surface2 },
    viewMenuOptionText: { color: colors.foreground, fontSize: 11 },
    viewMenuDivider: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
    board: {
      position: "relative" as const,
      flex: 1,
      minHeight: 0,
    },
    mobileBoard: {
      flex: 1,
      minHeight: 0,
      gap: 9,
      paddingHorizontal: boardPadding,
      paddingVertical: boardPadding,
    },
    mobileColumns: { flex: 1, minHeight: 0, width: "100%" as const },
    mobileColumnVisible: { flex: 1, minWidth: 0, minHeight: 0, width: "100%" as const },
    mobileColumnHidden: { display: "none" as const },
    boardPageScroll: { flex: 1, minHeight: 0 },
    boardPageContent: { flexGrow: 1, minHeight: 0 },
    boardScroll: { flex: compactStackBoardGroups ? 0 : 1, minHeight: 0 },
    boardScrollContent: {
      flexGrow: compactStackBoardGroups ? 0 : 1,
      minHeight: stackBoardGroups ? stackedBoardScrollHeight : 0,
      height: compactStackBoardGroups ? stackedBoardScrollHeight : undefined,
      paddingHorizontal: boardPadding,
      paddingVertical: boardPadding,
    },
    boardGroups: {
      flex: compactStackBoardGroups ? undefined : 1,
      flexGrow: compactStackBoardGroups ? 0 : undefined,
      flexShrink: compactStackBoardGroups ? 0 : undefined,
      flexBasis: compactStackBoardGroups ? "auto" as const : undefined,
      minHeight: stackBoardGroups ? stackedBoardGroupsHeight : 0,
      height: compactStackBoardGroups ? stackedBoardGroupsHeight : undefined,
      gap: BOARD_GROUP_GAP,
    },
    boardGroupsRow: { flexDirection: "row" as const },
    boardGroupsStacked: { flexDirection: "column" as const },
    boardGroup: {
      flex: compactStackBoardGroups ? 0 : 1,
      minWidth: stackBoardGroups ? 0 : activityGroupMinWidth,
      minHeight: stackBoardGroups ? stackedGroupMinHeight : 0,
      gap: 7,
    },
    boardGroupTitle: {
      height: 17,
      color: colors.foregroundMuted,
      fontSize: 9,
      fontWeight: "700" as const,
      letterSpacing: 0.7,
    },
    boardGroupHeading: {
      height: 17,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    boardGroupHint: { color: colors.foregroundMuted, fontSize: 9 },
    boardGroupColumns: {
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      flexDirection: "row" as const,
      alignItems: "stretch" as const,
      gap: BOARD_COLUMN_GAP,
    },
    organizationGroup: stackBoardGroups
      ? { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 9 }
      : {
        borderLeftWidth: 1,
        borderLeftColor: colors.border,
        paddingLeft: 11,
        minWidth: organizationGroupMinWidth + BOARD_GROUP_DECORATION_WIDTH,
      },
    column: {
      flex: 1,
      minWidth: responsiveColumnMinWidth,
      minHeight: 0,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface1,
      overflow: "hidden" as const,
    },
    columnHeader: {
      height: BOARD_COLUMN_HEADER_HEIGHT,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    columnTitle: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.3 },
    count: { color: colors.foregroundMuted, fontSize: 11 },
    columnContent: { padding: 8, gap: WORKSPACE_CARD_GAP },
    dropIndicator: {
      position: "absolute" as const,
      zIndex: 20,
      height: 3,
      left: 11,
      right: 11,
      borderRadius: 2,
    },
    empty: { color: colors.foregroundMuted, fontSize: 11, paddingHorizontal: 4, paddingVertical: 5 },
    workspaceCard: {
      gap: 4,
      paddingHorizontal: 9,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface0,
    },
    dragPreview: {
      position: "absolute" as const,
      left: 0,
      top: 0,
      zIndex: 10000,
      elevation: 10000,
      gap: 4,
      paddingHorizontal: 9,
      paddingVertical: 8,
      borderWidth: 1,
      borderLeftWidth: 3,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface0,
      shadowColor: "#000000",
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 8 },
    },
    workspaceCardDisabled: { opacity: 0.7 },
    workspaceCardDragSource: { opacity: 0 },
    cardTitleRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 6 },
    cardTitle: { flex: 1, color: colors.foreground, fontSize: 12, fontWeight: "600" as const, lineHeight: 17 },
    cardProject: { color: colors.foregroundMuted, fontSize: 10, lineHeight: 14 },
    cardDetail: { color: colors.foreground, fontSize: 10, lineHeight: 14 },
    prRow: {
      minHeight: 23,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      marginTop: 1,
    },
    prTitle: { flex: 1, color: colors.accent, fontSize: 10, fontWeight: "600" as const },
    prStatus: { fontSize: 10, fontWeight: "700" as const },
    cardFooter: {
      minHeight: 21,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      marginTop: 2,
      paddingTop: 5,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    stateDot: { width: 7, height: 7, borderRadius: 4 },
    stateText: { color: colors.foregroundMuted, fontSize: 10, fontWeight: "600" as const },
    cardActivity: { flex: 1, color: colors.foregroundMuted, fontSize: 10 },
    diffStat: { color: colors.foregroundMuted, fontSize: 9 },
    notice: { marginHorizontal: 13, marginTop: 9, color: colors.foregroundMuted, fontSize: 11 },
    error: { marginHorizontal: 13, marginTop: 9, color: colors.statusDanger, fontSize: 11 },
    modalBody: { flex: 1, minHeight: 0, gap: 12, padding: 18 },
    modalHeading: { color: colors.foreground, fontSize: 13, fontWeight: "700" as const },
    modalHint: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
    modalInput: {
      minHeight: 38,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 7,
      backgroundColor: colors.surface0,
      color: colors.foreground,
      fontSize: 13,
    },
    projectSearch: {
      minHeight: 34,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 7,
      backgroundColor: colors.surface0,
      color: colors.foreground,
      fontSize: 12,
    },
    projectRow: {
      minHeight: 41,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 9,
      paddingHorizontal: 9,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    projectMark: {
      width: 16,
      height: 16,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 4,
    },
    projectMarkSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
    projectLabel: { flex: 1, color: colors.foreground, fontSize: 12 },
    projectPath: { color: colors.foregroundMuted, fontSize: 10 },
    modalFooter: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingTop: 4 },
    footerSpacer: { flex: 1 },
    modalButton: {
      minHeight: 34,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 7,
      backgroundColor: colors.surface1,
    },
    modalButtonPrimary: { borderColor: colors.accent, backgroundColor: colors.accent },
    modalButtonDanger: { borderColor: colors.statusDanger },
    modalButtonText: { color: colors.foreground, fontSize: 12, fontWeight: "600" as const },
    modalButtonPrimaryText: { color: colors.accentForeground, fontSize: 12, fontWeight: "700" as const },
    dangerText: { color: colors.statusDanger, fontSize: 11 },
  }), [
    agentActivityGroupHeight,
    activityGroupMinWidth,
    boardPadding,
    colors,
    compact,
    compactStackBoardGroups,
    organizationGroupHeight,
    organizationGroupMinWidth,
    responsiveColumnMinWidth,
    stackBoardGroups,
    stackedBoardGroupsHeight,
    stackedBoardScrollHeight,
    stackedGroupMinHeight,
  ]);

  const canOpenWorkspace = Boolean(navigation?.openWorkspace);
  const openWorkspace = (workspaceId: string): void => {
    navigation?.openWorkspace({ workspaceId, serverId: host.id });
  };

  const openNewView = (): void => {
    setViewMenuOpen(false);
    setEditingViewId(null);
    setViewNameDraft("");
    setViewProjectIds([]);
    setProjectSearch("");
    setViewError("");
    setConfirmDelete(false);
    setViewModalOpen(true);
  };

  const openEditView = (view: DashboardView): void => {
    setViewMenuOpen(false);
    setEditingViewId(view.id);
    setViewNameDraft(view.name);
    setViewProjectIds([...view.projectIds]);
    setProjectSearch("");
    setViewError("");
    setConfirmDelete(false);
    setViewModalOpen(true);
  };

  const saveView = async (): Promise<void> => {
    if (settings.status !== "ready") return;
    const name = viewNameDraft.trim().replace(/\s+/g, " ");
    const selectedProjectIds = [...new Set(viewProjectIds)];
    if (!name) {
      setViewError("Give this view a name.");
      return;
    }
    if (!selectedProjectIds.length) {
      setViewError("Select at least one project.");
      return;
    }
    const duplicate = settings.values.dashboardViews.some((view) =>
      view.id !== editingViewId && view.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
    );
    if (duplicate) {
      setViewError("A view with this name already exists.");
      return;
    }
    const id = editingViewId ?? `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextView: DashboardView = { id, name, projectIds: selectedProjectIds };
    const dashboardViews = editingViewId
      ? settings.values.dashboardViews.map((view) => view.id === editingViewId ? nextView : view)
      : [...settings.values.dashboardViews, nextView];
    const didSave = await settings.save({ ...settings.values, dashboardViews }, settings.revision);
    if (didSave) {
      setSelectedViewId(id);
      setViewModalOpen(false);
    }
    else setViewError(settings.saveError || "Could not save this view.");
  };

  const deleteView = async (): Promise<void> => {
    if (!editingViewId || settings.status !== "ready") return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const dashboardViews = settings.values.dashboardViews.filter((view) => view.id !== editingViewId);
    const didSave = await settings.save({ ...settings.values, dashboardViews }, settings.revision);
    if (didSave) {
      setSelectedViewId("");
      setViewModalOpen(false);
    }
    else setViewError(settings.saveError || "Could not delete this view.");
  };

  const toggleProject = (projectId: string): void => {
    setViewProjectIds((current) => current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId]);
    setViewError("");
  };

  const measureDropZone = (queue: ManualDashboardQueue): void => {
    dropZoneRefs.current[queue]?.measureInWindow((x, y, width, height) => {
      dropZoneRects.current[queue] = { x, y, width, height };
    });
  };

  const measureCardDropTarget = (workspaceId: string): void => {
    const queue = cardDropQueues.current.get(workspaceId);
    cardDropRefs.current.get(workspaceId)?.measureInWindow((x, y, width, height) => {
      if (queue) cardDropRects.current.set(workspaceId, { x, y, width, height, queue });
    });
  };

  const measureQueueCards = (queue: ManualDashboardQueue): void => {
    for (const [workspaceId, cardQueue] of cardDropQueues.current) {
      if (cardQueue === queue) measureCardDropTarget(workspaceId);
    }
  };

  const setCardDropRef = (workspaceId: string, queue: ManualDashboardQueue, view: MeasuredView | null): void => {
    if (view) {
      cardDropRefs.current.set(workspaceId, view);
      cardDropQueues.current.set(workspaceId, queue);
      measureCardDropTarget(workspaceId);
    } else {
      cardDropRefs.current.delete(workspaceId);
      cardDropQueues.current.delete(workspaceId);
      cardDropRects.current.delete(workspaceId);
    }
  };

  const cardDropRefFor = (workspaceId: string, queue: ManualDashboardQueue): ((view: MeasuredView | null) => void) => {
    const key = `${queue}:${workspaceId}`;
    let callback = cardDropRefCallbacks.current.get(key);
    if (!callback) {
      callback = (view) => setCardDropRef(workspaceId, queue, view);
      cardDropRefCallbacks.current.set(key, callback);
    }
    return callback;
  };

  const cardMotionValueFor = (workspaceId: string): Animated.ValueXY => {
    let value = cardMotionValues.current.get(workspaceId);
    if (!value) {
      value = new Animated.ValueXY({ x: 0, y: 0 });
      cardMotionValues.current.set(workspaceId, value);
    }
    return value;
  };

  const cardArcValueFor = (workspaceId: string): Animated.Value => {
    let value = cardArcValues.current.get(workspaceId);
    if (!value) {
      value = new Animated.Value(0);
      cardArcValues.current.set(workspaceId, value);
    }
    return value;
  };

  const activityFlightMotionFor = (workspaceId: string): ActivityFlightMotion => {
    let motion = activityFlightMotionsRef.current.get(workspaceId);
    if (!motion) {
      motion = {
        position: new Animated.ValueXY({ x: 0, y: 0 }),
        arc: new Animated.Value(0),
        opacity: new Animated.Value(0.98),
        reveal: new Animated.Value(0),
      };
      activityFlightMotionsRef.current.set(workspaceId, motion);
    }
    return motion;
  };

  const cardMotionRefFor = (workspaceId: string, queue: QueueId): ((view: unknown) => void) => {
    const key = `${queue}:${workspaceId}`;
    let callback = cardMotionRefCallbacks.current.get(key);
    if (!callback) {
      callback = (value) => {
        const view = value as MeasuredView | null;
        if (view) cardMotionRefs.current.set(workspaceId, view);
        else cardMotionRefs.current.delete(workspaceId);
        if (manualQueues.includes(queue)) {
          cardDropRefFor(workspaceId, queue as ManualDashboardQueue)(view);
        }
      };
      cardMotionRefCallbacks.current.set(key, callback);
    }
    return callback;
  };

  const startActivityFlight = (workspaceId: string, previous: CardLayout, view: MeasuredView): void => {
    const motion = activityFlightMotionFor(workspaceId);
    const boardOrigin = boardWindowOriginRef.current;
    motion.position.stopAnimation();
    motion.arc.stopAnimation();
    motion.opacity.stopAnimation();
    motion.reveal.stopAnimation();
    motion.position.setValue({ x: previous.x - boardOrigin.x, y: previous.y - boardOrigin.y });
    motion.arc.setValue(0);
    motion.opacity.setValue(0.98);
    motion.reveal.setValue(0);
    setActivityFlightWorkspaceIds((current) => new Set(current).add(workspaceId));
    setActivityFlights((current) => [
      ...current.filter((flight) => flight.workspaceId !== workspaceId),
      { workspaceId, width: previous.width, height: previous.height },
    ]);

    requestAnimationFrame(() => {
      if (cardMotionRefs.current.get(workspaceId) !== view) return;
      view.measureInWindow((x, y) => {
        if (cardMotionRefs.current.get(workspaceId) !== view
          || activityFlightMotionsRef.current.get(workspaceId) !== motion) return;
        const currentBoardOrigin = boardWindowOriginRef.current;
        const target = { x: x - currentBoardOrigin.x, y: y - currentBoardOrigin.y };
        const useNativeDriver = layout.platform !== "web";
        Animated.parallel([
          Animated.timing(motion.position, {
            toValue: target,
            duration: 220,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver,
          }),
          Animated.sequence([
            Animated.timing(motion.arc, {
              toValue: 1,
              duration: 110,
              easing: Easing.out(Easing.quad),
              useNativeDriver,
            }),
            Animated.timing(motion.arc, {
              toValue: 0,
              duration: 110,
              easing: Easing.in(Easing.quad),
              useNativeDriver,
            }),
          ]),
        ]).start(({ finished }) => {
          if (!finished || activityFlightMotionsRef.current.get(workspaceId) !== motion) return;
          Animated.parallel([
            Animated.timing(motion.opacity, {
              toValue: 0,
              duration: 65,
              useNativeDriver,
            }),
            Animated.timing(motion.reveal, {
              toValue: 1,
              duration: 65,
              useNativeDriver,
            }),
          ]).start(({ finished: fadeFinished }) => {
            if (!fadeFinished || activityFlightMotionsRef.current.get(workspaceId) !== motion) return;
            setActivityFlights((current) => current.filter((flight) => flight.workspaceId !== workspaceId));
            setActivityFlightWorkspaceIds((current) => {
              if (!current.has(workspaceId)) return current;
              const next = new Set(current);
              next.delete(workspaceId);
              return next;
            });
            activityFlightMotionsRef.current.delete(workspaceId);
          });
        });
      });
    });
  };

  const clearDragPreview = (): void => {
    dragPreviewLiftAnimatingRef.current = false;
    dragPreviewTargetRef.current = null;
    dragPreviewMotion.stopAnimation();
    dragPreviewTilt.stopAnimation();
    dragPreviewLift.stopAnimation();
    dragPreviewOpacity.stopAnimation();
    dragPreviewOpacity.setValue(0.96);
    dragPreviewRef.current = null;
    setDragPreview(null);
  };

  const animateDropPreviewTo = (workspaceId: string, rect: DropRect): void => {
    if (dropLandingWorkspaceIdRef.current !== workspaceId || dropLandingAnimationStartedRef.current) return;
    if (dragPreviewRef.current?.workspaceId !== workspaceId) {
      dropLandingWorkspaceIdRef.current = null;
      dropLandingAnimationStartedRef.current = false;
      dropLandingReveal.setValue(1);
      setDropLandingWorkspaceId(null);
      clearDragPreview();
      return;
    }

    dropLandingAnimationStartedRef.current = true;
    const boardOrigin = boardWindowOriginRef.current;
    const target = { x: rect.x - boardOrigin.x, y: rect.y - boardOrigin.y };
    const useNativeDriver = layout.platform !== "web";
    dragPreviewMotion.stopAnimation();
    dragPreviewTilt.stopAnimation();
    dragPreviewLift.stopAnimation();
    dragPreviewOpacity.stopAnimation();
    dropLandingReveal.stopAnimation();
    Animated.parallel([
      Animated.timing(dragPreviewMotion, {
        toValue: target,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver,
      }),
      Animated.timing(dragPreviewTilt, {
        toValue: 0,
        duration: 125,
        useNativeDriver,
      }),
      Animated.timing(dragPreviewLift, {
        toValue: 0,
        duration: 125,
        useNativeDriver,
      }),
      Animated.sequence([
        Animated.delay(90),
        Animated.parallel([
          Animated.timing(dragPreviewOpacity, {
            toValue: 0,
            duration: 60,
            useNativeDriver,
          }),
          Animated.timing(dropLandingReveal, {
            toValue: 1,
            duration: 60,
            useNativeDriver,
          }),
        ]),
      ]),
    ]).start(({ finished }) => {
      if (!finished || dropLandingWorkspaceIdRef.current !== workspaceId) return;
      dropLandingReveal.setValue(1);
      dropLandingWorkspaceIdRef.current = null;
      dropLandingAnimationStartedRef.current = false;
      setDropLandingWorkspaceId(null);
      clearDragPreview();
    });
  };

  useLayoutEffect(() => {
    const previousLayouts = pendingCardLayoutsRef.current;
    if (!previousLayouts) return;
    pendingCardLayoutsRef.current = null;

    for (const [workspaceId, previous] of previousLayouts) {
      const view = cardMotionRefs.current.get(workspaceId);
      if (!view) continue;
      const currentQueue = currentQueueByWorkspace.get(workspaceId);
      if (workspaceId === dropLandingWorkspaceIdRef.current) {
        const motion = cardMotionValueFor(workspaceId);
        motion.stopAnimation();
        motion.setValue({ x: 0, y: 0 });
        setAnimatingWorkspaceIds((current) => {
          if (!current.has(workspaceId)) return current;
          const next = new Set(current);
          next.delete(workspaceId);
          return next;
        });
        requestAnimationFrame(() => {
          if (dropLandingWorkspaceIdRef.current !== workspaceId || cardMotionRefs.current.get(workspaceId) !== view) return;
          view.measureInWindow((x, y, width, height) => {
            if (dropLandingWorkspaceIdRef.current !== workspaceId || cardMotionRefs.current.get(workspaceId) !== view) return;
            animateDropPreviewTo(workspaceId, { x, y, width, height });
          });
        });
        continue;
      }
      if (previous.queue && currentQueue
        && previous.queue !== currentQueue
        && isActivityQueue(previous.queue)
        && isActivityQueue(currentQueue)) {
        const motion = cardMotionValueFor(workspaceId);
        const arc = cardArcValueFor(workspaceId);
        motion.stopAnimation();
        motion.setValue({ x: 0, y: 0 });
        arc.stopAnimation();
        arc.setValue(0);
        setAnimatingWorkspaceIds((current) => {
          if (!current.has(workspaceId)) return current;
          const next = new Set(current);
          next.delete(workspaceId);
          return next;
        });
        startActivityFlight(workspaceId, previous, view);
        continue;
      }
      if (previous.queue && currentQueue && previous.queue !== currentQueue) {
        const motion = cardMotionValueFor(workspaceId);
        const arc = cardArcValueFor(workspaceId);
        motion.stopAnimation();
        motion.setValue({ x: 0, y: 0 });
        arc.stopAnimation();
        arc.setValue(0);
        setAnimatingWorkspaceIds((current) => {
          if (!current.has(workspaceId)) return current;
          const next = new Set(current);
          next.delete(workspaceId);
          return next;
        });
        continue;
      }
      view.measureInWindow((x, y) => {
        if (cardMotionRefs.current.get(workspaceId) !== view) return;
        const deltaX = previous.x - x;
        const deltaY = previous.y - y;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

        const motion = cardMotionValueFor(workspaceId);
        const arc = cardArcValueFor(workspaceId);
        motion.stopAnimation();
        motion.setValue({ x: deltaX, y: deltaY });
        const isActivityReorder = isActivityQueue(currentQueue) && Math.abs(deltaY) >= 2;
        arc.stopAnimation();
        arc.setValue(0);
        setAnimatingWorkspaceIds((current) => new Set(current).add(workspaceId));
        const useNativeDriver = layout.platform !== "web";
        const settleMotion = Animated.spring(motion, {
          toValue: { x: 0, y: 0 },
          friction: 12,
          tension: 70,
          useNativeDriver,
        });
        const animation = isActivityReorder
          ? Animated.parallel([
            settleMotion,
            Animated.sequence([
              Animated.timing(arc, { toValue: 1, duration: 95, easing: Easing.out(Easing.quad), useNativeDriver }),
              Animated.timing(arc, { toValue: 0, duration: 95, easing: Easing.in(Easing.quad), useNativeDriver }),
            ]),
          ])
          : settleMotion;
        animation.start(({ finished }) => {
          if (finished) {
            arc.setValue(0);
            setAnimatingWorkspaceIds((current) => {
              if (!current.has(workspaceId)) return current;
              const next = new Set(current);
              next.delete(workspaceId);
              return next;
            });
          }
        });
      });
    }
  }, [currentQueueByWorkspace, grouped, layout.platform]);

  const dropTargetAtPoint = (x: number, y: number): DropTarget | null => {
    const queue = manualQueues.find((candidate) => {
      if (compact && mobileActiveQueueRef.current !== candidate) return false;
      const rect = dropZoneRects.current[candidate];
      return Boolean(rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
    });
    if (!queue) return null;
    const before = [...cardDropRects.current.entries()]
      .filter(([workspaceId, rect]) => workspaceId !== draggedWorkspaceIdRef.current && rect.queue === queue)
      .sort((left, right) => left[1].y - right[1].y)
      .find(([, rect]) => y < rect.y + rect.height / 2);
    return { queue, beforeWorkspaceId: before?.[0] ?? null };
  };

  const sameDropTarget = (left: DropTarget | null, right: DropTarget | null): boolean =>
    left?.queue === right?.queue && left?.beforeWorkspaceId === right?.beforeWorkspaceId;

  const setDragPreviewPosition = (
    workspaceId: string,
    x: number,
    y: number,
    rect: DropRect,
    animateFromList: boolean,
  ): void => {
    const preview: DragPreview = {
      workspaceId,
      width: rect.width,
      height: rect.height,
      offsetX: Math.max(0, Math.min(rect.width, x - rect.x)),
      offsetY: Math.max(0, Math.min(rect.height, y - rect.y)),
    };
    const boardOrigin = boardWindowOriginRef.current;
    const start = { x: rect.x - boardOrigin.x, y: rect.y - boardOrigin.y };
    const target = {
      x: x - boardOrigin.x - preview.offsetX,
      y: y - boardOrigin.y - preview.offsetY,
    };

    dragPreviewRef.current = preview;
    dragPreviewTargetRef.current = target;
    setDragPreview(preview);
    dragPreviewMotion.stopAnimation();
    dragPreviewTilt.stopAnimation();
    dragPreviewLift.stopAnimation();
    dragPreviewOpacity.stopAnimation();
    dragPreviewOpacity.setValue(0.96);

    if (!animateFromList) {
      dragPreviewMotion.setValue(target);
      dragPreviewTilt.setValue(1);
      dragPreviewLift.setValue(1);
      dragPreviewLiftAnimatingRef.current = false;
      return;
    }

    dragPreviewMotion.setValue(start);
    dragPreviewTilt.setValue(0);
    dragPreviewLift.setValue(0);
    dragPreviewLiftAnimatingRef.current = true;
    const useNativeDriver = layout.platform !== "web";
    Animated.spring(dragPreviewMotion, {
      toValue: target,
      friction: 11,
      tension: 115,
      useNativeDriver,
    }).start();
    Animated.parallel([
      Animated.timing(dragPreviewTilt, {
        toValue: 1,
        duration: 150,
        useNativeDriver,
      }),
      Animated.timing(dragPreviewLift, {
        toValue: 1,
        duration: 150,
        useNativeDriver,
      }),
    ]).start(({ finished }) => {
      if (draggedWorkspaceIdRef.current !== workspaceId) return;
      dragPreviewLiftAnimatingRef.current = false;
      if (finished && dragPreviewTargetRef.current) {
        dragPreviewMotion.setValue(dragPreviewTargetRef.current);
      }
    });
  };

  const updateDragPreview = (workspaceId: string, x: number, y: number): void => {
    let preview = dragPreviewRef.current;
    if (!preview || preview.workspaceId !== workspaceId) {
      const rect = cardDropRects.current.get(workspaceId);
      if (!rect) return;
      setDragPreviewPosition(workspaceId, x, y, rect, false);
      return;
    }
    const boardOrigin = boardWindowOriginRef.current;
    const target = {
      x: x - boardOrigin.x - preview.offsetX,
      y: y - boardOrigin.y - preview.offsetY,
    };
    const previousTarget = dragPreviewTargetRef.current;
    dragPreviewTargetRef.current = target;
    const targetMoved = !previousTarget
      || Math.abs(previousTarget.x - target.x) > 0.5
      || Math.abs(previousTarget.y - target.y) > 0.5;
    if (targetMoved) dragPreviewMotion.setValue(target);
  };

  const beginWorkspaceDrag = (workspaceId: string, x: number, y: number): void => {
    for (const queue of manualQueues) {
      measureDropZone(queue);
      measureQueueCards(queue);
    }
    dropLandingWorkspaceIdRef.current = null;
    dropLandingAnimationStartedRef.current = false;
    dropLandingReveal.setValue(1);
    setDropLandingWorkspaceId(null);
    clearDragPreview();
    draggedWorkspaceIdRef.current = workspaceId;
    const sourceRect = cardDropRects.current.get(workspaceId);
    if (sourceRect) setDragPreviewPosition(workspaceId, x, y, sourceRect, true);
    setDraggedWorkspaceId(workspaceId);
    setDropTarget(null);
  };

  const updateWorkspaceDrag = (x: number, y: number): void => {
    const workspaceId = draggedWorkspaceIdRef.current;
    if (workspaceId) updateDragPreview(workspaceId, x, y);
    const target = dropTargetAtPoint(x, y);
    setDropTarget((current) => sameDropTarget(current, target) ? current : target);
  };

  const cancelWorkspaceDrag = (workspaceId: string): void => {
    if (draggedWorkspaceIdRef.current === workspaceId) draggedWorkspaceIdRef.current = null;
    dropLandingWorkspaceIdRef.current = null;
    dropLandingAnimationStartedRef.current = false;
    dropLandingReveal.setValue(1);
    setDropLandingWorkspaceId(null);
    clearDragPreview();
    setDraggedWorkspaceId((current) => current === workspaceId ? null : current);
    setDropTarget(null);
  };

  const moveWorkspaceToQueue = async (
    workspaceId: string,
    queue: ManualDashboardQueue,
    beforeWorkspaceId: string | null = null,
  ): Promise<boolean> => {
    if (organizationSettings.status !== "ready" || organizationSettings.saving) return false;
    const nextOverrides = new Map(queueOverrideMap);
    nextOverrides.set(workspaceId, queue);
    const workspaceQueueOverrides = [...nextOverrides].map(([id, target]) => ({ workspaceId: id, queue: target }));

    const nextOrder = Object.fromEntries(manualQueues.map((target) => [
      target,
      (workspaceOrder[target] ?? []).filter((id) => id !== workspaceId),
    ])) as DashboardWorkspaceOrder;
    const visibleTargetIds = (grouped[queue] as WorkspaceCardData[])
      .map((card) => card.workspace.id)
      .filter((id) => id !== workspaceId);
    const insertionIndex = beforeWorkspaceId ? visibleTargetIds.indexOf(beforeWorkspaceId) : -1;
    visibleTargetIds.splice(insertionIndex < 0 ? visibleTargetIds.length : insertionIndex, 0, workspaceId);
    const hiddenTargetIds = (nextOrder[queue] ?? []).filter((id) => !visibleTargetIds.includes(id));
    nextOrder[queue] = [...visibleTargetIds, ...hiddenTargetIds];

    pendingCardLayoutsRef.current = await measureCardLayouts(cardMotionRefs.current, currentQueueByWorkspace);
    queueOverridesRef.current = nextOverrides;
    setManualQueueOverrideDrafts((current) => ({ ...current, [workspaceId]: queue }));
    setManualWorkspaceOrderDrafts(nextOrder);
    const didSave = await organizationSettings.save(
      { workspaceQueueOverrides, workspaceOrder: nextOrder },
      organizationSettings.revision,
    );
    if (!didSave) {
      pendingCardLayoutsRef.current = await measureCardLayouts(cardMotionRefs.current, currentQueueByWorkspace);
      queueOverridesRef.current = persistedQueueOverrideMap;
      setManualQueueOverrideDrafts((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setManualWorkspaceOrderDrafts(null);
      setConnectionWarning(organizationSettings.saveError || "Could not save this workspace's dashboard organization.");
    }
    return true;
  };

  const finishWorkspaceDrag = (workspaceId: string, x: number, y: number): void => {
    const target = dropTargetAtPoint(x, y);
    updateDragPreview(workspaceId, x, y);
    if (draggedWorkspaceIdRef.current === workspaceId) draggedWorkspaceIdRef.current = null;
    dropLandingWorkspaceIdRef.current = workspaceId;
    dropLandingAnimationStartedRef.current = false;
    dropLandingReveal.setValue(0);
    setDropLandingWorkspaceId(workspaceId);
    setDraggedWorkspaceId(null);
    setDropTarget(null);
    if (target && organizationSettings.status === "ready" && !organizationSettings.saving) {
      void moveWorkspaceToQueue(workspaceId, target.queue, target.beforeWorkspaceId).then((started) => {
        if (started || dropLandingWorkspaceIdRef.current !== workspaceId) return;
        const sourceRect = cardDropRects.current.get(workspaceId);
        if (sourceRect) animateDropPreviewTo(workspaceId, sourceRect);
        else {
          dropLandingWorkspaceIdRef.current = null;
          dropLandingReveal.setValue(1);
          setDropLandingWorkspaceId(null);
          clearDragPreview();
        }
      });
      return;
    }
    const sourceRect = cardDropRects.current.get(workspaceId);
    if (sourceRect) animateDropPreviewTo(workspaceId, sourceRect);
    else {
      dropLandingWorkspaceIdRef.current = null;
      dropLandingReveal.setValue(1);
      setDropLandingWorkspaceId(null);
      clearDragPreview();
    }
  };

  const columnAccents: Record<QueueId, string> = columnColors;

  const renderCard = (card: WorkspaceCardData) => {
    const workspace = card.workspace;
    const pullRequest = workspace.githubRuntime?.pullRequest;
    const branch = workspace.gitRuntime?.currentBranch || workspace.worktreeSlug;
    const projectName = workspace.projectCustomName?.trim() || workspace.projectDisplayName;
    const stateLabel = columnNames[card.queue] ?? card.queue;
    const stateColor = columnAccents[card.queue];
    const canManuallyOrganize = manualQueues.includes(card.queue);
    const cardMotion = cardMotionValueFor(workspace.id);
    const cardArc = cardArcValueFor(workspace.id);
    const activityFlightMotion = activityFlightWorkspaceIds.has(workspace.id)
      ? activityFlightMotionsRef.current.get(workspace.id)
      : undefined;
    const cardReveal = dropLandingWorkspaceId === workspace.id
      ? dropLandingReveal
      : activityFlightMotion?.reveal;
    let pullRequestStatus = "";
    let pullRequestStatusColor = colors.foregroundMuted;
    let pullRequestMark = "·";
    if (pullRequest) {
      if (pullRequest.checksStatus === "failure" || pullRequest.mergeable === "CONFLICTING") {
        pullRequestStatus = pullRequest.mergeable === "CONFLICTING" ? "Conflicts" : "Checks failed";
        pullRequestStatusColor = colors.statusDanger;
        pullRequestMark = "!";
      } else if (pullRequest.reviewDecision === "approved") {
        pullRequestStatus = "Approved";
        pullRequestStatusColor = colors.statusSuccess;
        pullRequestMark = "✓";
      } else if (pullRequest.checksStatus === "success") {
        pullRequestStatus = "Checks passed";
        pullRequestStatusColor = colors.statusSuccess;
        pullRequestMark = "✓";
      } else if (pullRequest.checksStatus === "pending") {
        pullRequestStatus = "Checks running";
        pullRequestStatusColor = colors.statusWarning;
        pullRequestMark = "…";
      } else if (pullRequest.state.toLocaleLowerCase() === "merged" || pullRequest.isMerged) {
        pullRequestStatus = "Merged";
        pullRequestStatusColor = colors.statusSuccess;
        pullRequestMark = "✓";
      } else if (pullRequest.reviewDecision === "changes_requested") {
        pullRequestStatus = "Changes requested";
        pullRequestStatusColor = colors.statusWarning;
        pullRequestMark = "!";
      }
    }

    return (
      <Animated.View
        key={workspace.id}
        ref={cardMotionRefFor(workspace.id, card.queue)}
        onLayout={canManuallyOrganize ? () => measureCardDropTarget(workspace.id) : undefined}
        style={[
          styles.workspaceCard,
          {
            borderLeftWidth: 3,
            borderLeftColor: stateColor,
            transform: [
              ...cardMotion.getTranslateTransform(),
              ...(isActivityQueue(card.queue)
                ? [{ translateY: cardArc.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -8, 0] }) }]
                : []),
            ],
            ...(animatingWorkspaceIds.has(workspace.id) ? { zIndex: 50, elevation: 50 } : {}),
          },
          !canOpenWorkspace && styles.workspaceCardDisabled,
          (draggedWorkspaceId === workspace.id || dropLandingWorkspaceId === workspace.id)
            && styles.workspaceCardDragSource,
          cardReveal ? { opacity: cardReveal } : null,
        ]}
      >
        <WorkspaceDragSurface
          workspaceId={workspace.id}
          compact={compact}
          disabled={!canManuallyOrganize || organizationSettings.status !== "ready" || organizationSettings.saving}
          onDragStart={beginWorkspaceDrag}
          onDragMove={updateWorkspaceDrag}
          onDrop={finishWorkspaceDrag}
          onDragCancel={cancelWorkspaceDrag}
        >
        <View style={styles.cardTitleRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${workspace.title || workspace.name}`}
            disabled={!canOpenWorkspace}
            onPress={() => openWorkspace(workspace.id)}
            style={{ flex: 1 }}
          >
            <Text style={styles.cardTitle} numberOfLines={2}>
              {workspace.title?.trim() || workspace.name}
            </Text>
          </Pressable>
          {workspace.diffStat ? (
            <Text style={styles.diffStat}>+{workspace.diffStat.additions} / -{workspace.diffStat.deletions}</Text>
          ) : null}
        </View>
        <Text style={styles.cardProject} numberOfLines={1}>
          {projectName}{branch ? ` · ${branch}` : ""}
        </Text>
        {card.attentionKinds.length && card.detail !== "Unread activity" ? (
          <Text style={styles.cardDetail} numberOfLines={1}>{card.detail}</Text>
        ) : null}
        {pullRequest ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open pull request ${pullRequest.number ?? ""}: ${pullRequest.title}`}
            onPress={() => {
              void openExternalUrl(pullRequest.url).catch((error) => {
                setConnectionWarning(`Could not open pull request: ${errorMessage(error)}`);
              });
            }}
            style={styles.prRow}
          >
            <Text style={styles.prTitle} numberOfLines={1}>
              ↗ PR #{pullRequest.number ?? "?"} · {pullRequest.title}
            </Text>
            {pullRequestStatus ? (
              <Text style={[styles.prStatus, { color: pullRequestStatusColor }]}>
                {pullRequestMark} {pullRequestStatus}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        <View style={styles.cardFooter}>
          <View style={[styles.stateDot, { backgroundColor: stateColor }]} />
          <Text style={styles.stateText}>{stateLabel}</Text>
          <Text style={styles.cardActivity} numberOfLines={1}>
            {formatActivityDate(workspace.activityAt ?? workspace.statusEnteredAt)}
          </Text>
          {workspace.gitRuntime?.isDirty ? <Text style={styles.diffStat}>Modified</Text> : null}
        </View>
        </WorkspaceDragSurface>
      </Animated.View>
    );
  };

  const activityColumns: Array<{ id: QueueId; title: string; cards: WorkspaceCardData[] }> = activityColumnOrder.map((id) => ({
    id,
    title: columnNames[id],
    cards: id === "unread" ? grouped.unread : id === "needs-attention" ? grouped.needsAttention : grouped.running,
  }));
  const organizationColumns: Array<{ id: QueueId; title: string; cards: WorkspaceCardData[] }> = [
    ...manualQueues.map((id) => ({ id, title: columnNames[id], cards: grouped[id] as WorkspaceCardData[] })),
  ];
  const renderColumn = (
    { id, title, cards }: { id: QueueId; title: string; cards: WorkspaceCardData[] },
    singleColumn = false,
  ) => {
    const canReceiveDrop = manualQueues.includes(id);
    const queue = canReceiveDrop ? id as ManualDashboardQueue : null;
    const visibleCards = cards;
    const isDropTarget = Boolean(draggedWorkspaceId && dropTarget?.queue === id);
    const cardItems = (
      <>
        {visibleCards.map((card) => (
          <Fragment key={card.workspace.id}>{renderCard(card)}</Fragment>
        ))}
        {!visibleCards.length && !isDropTarget ? <Text style={styles.empty}>None</Text> : null}
      </>
    );
    let dropIndicatorTop: number | null = null;
    if (isDropTarget && queue) {
      const columnRect = dropZoneRects.current[queue];
      if (columnRect) {
        const beforeRect = dropTarget?.beforeWorkspaceId
          ? cardDropRects.current.get(dropTarget.beforeWorkspaceId)
          : undefined;
        const queueRects = [...cardDropRects.current.entries()]
          .filter(([workspaceId, rect]) => workspaceId !== draggedWorkspaceIdRef.current && rect.queue === queue)
          .map(([, rect]) => rect);
        const lastRect = queueRects.reduce<DropRect | null>(
          (last, rect) => !last || rect.y + rect.height > last.y + last.height ? rect : last,
          null,
        );
        const markerWindowY = beforeRect
          ? beforeRect.y - WORKSPACE_CARD_GAP / 2
          : lastRect
            ? lastRect.y + lastRect.height + WORKSPACE_CARD_GAP / 2
            : columnRect.y + BOARD_COLUMN_HEADER_HEIGHT + 8;
        dropIndicatorTop = Math.max(
          BOARD_COLUMN_HEADER_HEIGHT + 1,
          Math.min(columnRect.height - 5, markerWindowY - columnRect.y - 1.5),
        );
      }
    }
    return (
      <View
        key={id}
        ref={queue ? (view) => {
          if (view) dropZoneRefs.current[queue] = view;
          else delete dropZoneRefs.current[queue];
        } : undefined}
        onLayout={queue ? () => measureDropZone(queue) : undefined}
        style={[styles.column, singleColumn && { minWidth: 0 }]}
      >
        <View style={[styles.columnHeader, { borderBottomColor: columnAccents[id] }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: columnAccents[id] }} />
            <Text numberOfLines={1} style={[styles.columnTitle, { color: colors.foreground, flexShrink: 1 }]}>
              {title}
            </Text>
          </View>
          <Text style={styles.count}>{cards.length}</Text>
        </View>
        <ScrollView
          nestedScrollEnabled
          onScroll={queue && draggedWorkspaceId ? () => measureQueueCards(queue) : undefined}
          scrollEventThrottle={draggedWorkspaceId ? 32 : undefined}
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={styles.columnContent}
        >
          {cardItems}
        </ScrollView>
        {dropIndicatorTop !== null ? (
          <View
            pointerEvents="none"
            accessibilityLabel="Card drop position"
            style={[styles.dropIndicator, { top: dropIndicatorTop, backgroundColor: columnAccents[id] }]}
          />
        ) : null}
      </View>
    );
  };
  const mobileQueueTabs: MobileQueueTab[] = [
    ...activityColumns.map((column) => ({ id: column.id, title: column.title, count: column.cards.length, color: columnAccents[column.id] })),
    ...organizationColumns.map((column) => ({ id: column.id, title: column.title, count: column.cards.length, color: columnAccents[column.id] })),
  ];
  const mobileBoard = (
    <View style={styles.mobileBoard}>
      <MobileQueueTabs
        activityTabs={mobileQueueTabs.slice(0, 3)}
        organizationTabs={mobileQueueTabs.slice(3)}
        activeQueue={activeMobileQueue}
        isDragging={Boolean(draggedWorkspaceId)}
        borderColor={colors.border}
        foregroundColor={colors.foreground}
        mutedColor={colors.foregroundMuted}
        surfaceColor={colors.surface1}
        activeSurfaceColor={colors.surface2}
        onSelect={selectMobileQueue}
      />
      <View style={styles.mobileColumns}>
        {[...activityColumns, ...organizationColumns].map((column) => (
          <View
            key={`mobile-${column.id}`}
            pointerEvents={column.id === activeMobileQueue ? "auto" : "none"}
            style={column.id === activeMobileQueue ? styles.mobileColumnVisible : styles.mobileColumnHidden}
          >
            {renderColumn(column, true)}
          </View>
        ))}
      </View>
    </View>
  );
  const filteredProjects = (data?.projects ?? []).filter((project) => {
    const query = projectSearch.trim().toLocaleLowerCase();
    return !query || `${projectTitle(project)} ${project.projectRootPath}`.toLocaleLowerCase().includes(query);
  });
  const workspaceCards = [
    ...grouped.unread,
    ...grouped.needsAttention,
    ...grouped.running,
    ...manualQueues.flatMap((queue) => grouped[queue] as WorkspaceCardData[]),
  ];
  const dragPreviewCard = dragPreview
    ? workspaceCards.find((card) => card.workspace.id === dragPreview.workspaceId) ?? null
    : null;
  const renderFloatingCardContents = (card: WorkspaceCardData) => (
    <>
      <Text style={styles.cardTitle} numberOfLines={2}>
        {card.workspace.title?.trim() || card.workspace.name}
      </Text>
      <Text style={styles.cardProject} numberOfLines={1}>
        {card.workspace.projectCustomName?.trim() || card.workspace.projectDisplayName}
        {(card.workspace.gitRuntime?.currentBranch || card.workspace.worktreeSlug)
          ? ` · ${card.workspace.gitRuntime?.currentBranch || card.workspace.worktreeSlug}`
          : ""}
      </Text>
      {card.attentionKinds.length && card.detail !== "Unread activity" ? (
        <Text style={styles.cardDetail} numberOfLines={1}>{card.detail}</Text>
      ) : null}
      {card.workspace.githubRuntime?.pullRequest ? (
        <Text style={styles.prTitle} numberOfLines={1}>
          ↗ PR #{card.workspace.githubRuntime.pullRequest.number ?? "?"} · {card.workspace.githubRuntime.pullRequest.title}
        </Text>
      ) : null}
      <View style={styles.cardFooter}>
        <View style={[styles.stateDot, { backgroundColor: columnAccents[card.queue] }]} />
        <Text style={styles.stateText}>{columnNames[card.queue]}</Text>
        <Text style={styles.cardActivity} numberOfLines={1}>
          {formatActivityDate(card.workspace.activityAt ?? card.workspace.statusEnteredAt)}
        </Text>
      </View>
    </>
  );
  const renderedBoardGroups = (
    <View
      style={[
        styles.boardGroups,
        stackBoardGroups ? styles.boardGroupsStacked : styles.boardGroupsRow,
        { width: boardScrollContentWidth - boardPadding * 2 },
      ]}
    >
      <View style={[
        styles.boardGroup,
        compactStackBoardGroups && {
          height: agentActivityGroupHeight,
          minHeight: agentActivityGroupHeight,
        },
      ]}>
        <View style={styles.boardGroupHeading}>
          <Text style={styles.boardGroupTitle}>AGENT ACTIVITY</Text>
        </View>
        <View style={styles.boardGroupColumns}>{activityColumns.map((column) => renderColumn(column))}</View>
      </View>
      <View style={[
        styles.boardGroup,
        styles.organizationGroup,
        compactStackBoardGroups && {
          height: organizationGroupHeight,
          minHeight: organizationGroupHeight,
        },
      ]}>
        <View style={styles.boardGroupHeading}>
          <Text style={styles.boardGroupTitle}>WORKSPACE ORGANIZATION</Text>
          <Text style={styles.boardGroupHint}>
            {compact ? "Swipe columns · hold a card to move" : "Drag cards between columns"}
          </Text>
        </View>
        <View style={styles.boardGroupColumns}>{organizationColumns.map((column) => renderColumn(column))}</View>
      </View>
    </View>
  );
  const boardScrollView = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      onScroll={() => {
        for (const queue of manualQueues) {
          measureDropZone(queue);
          if (draggedWorkspaceId) measureQueueCards(queue);
        }
      }}
      scrollEventThrottle={32}
      contentContainerStyle={[
        styles.boardScrollContent,
        {
          width: boardScrollContentWidth,
          ...(!stackBoardGroups && boardViewportHeight > 0 ? { height: boardViewportHeight } : {}),
        },
      ]}
      style={[
        styles.boardScroll,
        stackBoardGroups && {
          minHeight: stackedBoardScrollHeight,
          ...(compactStackBoardGroups ? { height: stackedBoardScrollHeight } : {}),
        },
      ]}
    >
      {renderedBoardGroups}
    </ScrollView>
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headingRow}>
          <Text style={styles.heading}>Paseo Dashboard</Text>
          <Text style={styles.total}>{grouped.total} total</Text>
          <View
            style={styles.viewPickerWrap}
            onLayout={(event) => setViewPickerLeft(event.nativeEvent.layout.x)}
          >
            <Pressable
              accessibilityLabel="Choose dashboard view"
              accessibilityRole="button"
              accessibilityState={{ expanded: viewMenuOpen }}
              onPress={() => setViewMenuOpen((open) => !open)}
              style={styles.viewPickerButton}
            >
              <Text numberOfLines={1} style={styles.viewPickerLabel}>{activeView?.name || "All projects"}</Text>
              <Text style={styles.buttonText}>{viewMenuOpen ? "⌃" : "⌄"}</Text>
            </Pressable>
          </View>
          <View style={styles.headerActions}>
            {activeView ? (
              <Pressable accessibilityLabel={`Edit ${activeView.name}`} accessibilityRole="button" onPress={() => openEditView(activeView)} style={styles.iconButton}>
                <Text style={styles.buttonText}>Edit</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityLabel="Create project view" accessibilityRole="button" onPress={openNewView} style={styles.iconButton}>
              <Text style={{ ...styles.buttonText, color: colors.accent }}>+ View</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Refresh dashboard"
              accessibilityRole="button"
              disabled={refreshing}
              onPress={() => { setLoadError(""); setReloadKey((current) => current + 1); }}
              style={styles.iconButton}
            >
              <Text style={styles.buttonText}>{refreshing ? "..." : "Refresh"}</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.toolbar}>
          <View style={styles.searchBox}>
            <Text style={styles.searchIcon}>⌕</Text>
            <TextInput
              accessibilityLabel="Search workspaces, projects, or agents"
              onChangeText={setSearch}
              placeholder="Search worktree, project, or agent..."
              placeholderTextColor={colors.foregroundMuted}
              style={styles.searchInput}
              value={search}
            />
            {!compact ? <Text style={styles.searchHint}>Ctrl + K</Text> : null}
          </View>
        </View>
      </View>

      {viewMenuOpen ? (
        <View
          style={[
            styles.viewMenu,
            { top: (compact ? 12 : 15) + 34, left: viewPickerLeft + (compact ? 12 : 20) },
          ]}
        >
          <Text style={styles.viewMenuHeading}>DASHBOARD VIEWS</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: !activeView }}
            onPress={() => { setSelectedViewId(""); setViewMenuOpen(false); }}
            style={[styles.viewMenuOption, !activeView && styles.viewMenuOptionSelected]}
          >
            <Text style={styles.viewMenuOptionText}>All projects</Text>
          </Pressable>
          {savedViews.map((view) => (
            <Pressable
              key={view.id}
              accessibilityRole="button"
              accessibilityState={{ selected: activeView?.id === view.id }}
              onPress={() => { setSelectedViewId(view.id); setViewMenuOpen(false); }}
              style={[styles.viewMenuOption, activeView?.id === view.id && styles.viewMenuOptionSelected]}
            >
              <Text numberOfLines={1} style={styles.viewMenuOptionText}>{view.name}</Text>
            </Pressable>
          ))}
          <View style={styles.viewMenuDivider} />
          <Pressable accessibilityRole="button" onPress={openNewView} style={styles.viewMenuOption}>
            <Text style={{ ...styles.viewMenuOptionText, color: colors.accent }}>+ Create view</Text>
          </Pressable>
        </View>
      ) : null}

      {loadError ? <Text style={styles.error}>Could not load dashboard data: {loadError}</Text> : null}
      {connectionWarning ? <Text style={styles.notice}>{connectionWarning}</Text> : null}
      {!data && !loadError ? <Text style={styles.notice}>Loading workspaces...</Text> : null}

      {data ? (
        <View
          style={styles.board}
          ref={(view) => { boardViewRef.current = view as unknown as MeasuredView | null; }}
          onLayout={(event) => {
            const width = event.nativeEvent.layout.width;
            const height = event.nativeEvent.layout.height;
            setBoardViewportWidth((current) => Math.abs(current - width) > 1 ? width : current);
            setBoardViewportHeight((current) => Math.abs(current - height) > 1 ? height : current);
            boardViewRef.current?.measureInWindow((x, y) => { boardWindowOriginRef.current = { x, y }; });
          }}
        >
          {compact ? mobileBoard : stackBoardGroups ? (
            <ScrollView
              nestedScrollEnabled
              showsVerticalScrollIndicator
              style={styles.boardPageScroll}
              contentContainerStyle={styles.boardPageContent}
            >
              {boardScrollView}
            </ScrollView>
          ) : boardScrollView}
          {dragPreview && dragPreviewCard ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.dragPreview,
                {
                  width: dragPreview.width,
                  height: dragPreview.height,
                  opacity: dragPreviewOpacity,
                  borderLeftColor: columnAccents[dragPreviewCard.queue],
                  transform: [
                    ...dragPreviewMotion.getTranslateTransform(),
                    { translateY: dragPreviewLift.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) },
                    { rotate: dragPreviewTilt.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "-2deg"] }) },
                    { scale: dragPreviewLift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }) },
                  ],
                },
              ]}
            >
              <Text style={styles.cardTitle} numberOfLines={2}>
                {dragPreviewCard.workspace.title?.trim() || dragPreviewCard.workspace.name}
              </Text>
              <Text style={styles.cardProject} numberOfLines={1}>
                {dragPreviewCard.workspace.projectCustomName?.trim() || dragPreviewCard.workspace.projectDisplayName}
                {(dragPreviewCard.workspace.gitRuntime?.currentBranch || dragPreviewCard.workspace.worktreeSlug)
                  ? ` · ${dragPreviewCard.workspace.gitRuntime?.currentBranch || dragPreviewCard.workspace.worktreeSlug}`
                  : ""}
              </Text>
              {dragPreviewCard.attentionKinds.length && dragPreviewCard.detail !== "Unread activity" ? (
                <Text style={styles.cardDetail} numberOfLines={1}>{dragPreviewCard.detail}</Text>
              ) : null}
              {dragPreviewCard.workspace.githubRuntime?.pullRequest ? (
                <Text style={styles.prTitle} numberOfLines={1}>
                  ↗ PR #{dragPreviewCard.workspace.githubRuntime.pullRequest.number ?? "?"} · {dragPreviewCard.workspace.githubRuntime.pullRequest.title}
                </Text>
              ) : null}
              <View style={styles.cardFooter}>
                <View style={[styles.stateDot, { backgroundColor: columnAccents[dragPreviewCard.queue] }]} />
                <Text style={styles.stateText}>{columnNames[dragPreviewCard.queue]}</Text>
                <Text style={styles.cardActivity} numberOfLines={1}>
                  {formatActivityDate(dragPreviewCard.workspace.activityAt ?? dragPreviewCard.workspace.statusEnteredAt)}
                </Text>
              </View>
            </Animated.View>
          ) : null}
          {activityFlights.map((flight) => {
            const card = workspaceCards.find((item) => item.workspace.id === flight.workspaceId);
            const motion = activityFlightMotionsRef.current.get(flight.workspaceId);
            if (!card || !motion) return null;
            return (
              <Animated.View
                key={`activity-flight:${flight.workspaceId}`}
                pointerEvents="none"
                style={[
                  styles.dragPreview,
                  {
                    width: flight.width,
                    height: flight.height,
                    opacity: motion.opacity,
                    borderLeftColor: columnAccents[card.queue],
                    transform: [
                      ...motion.position.getTranslateTransform(),
                      { translateY: motion.arc.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -14, 0] }) },
                    ],
                  },
                ]}
              >
                {renderFloatingCardContents(card)}
              </Animated.View>
            );
          })}
        </View>
      ) : null}

      <Modal
        open={viewModalOpen}
        title={editingViewId ? "Edit project view" : "Create project view"}
        onOpenChange={(open) => { if (!open) { setViewModalOpen(false); setConfirmDelete(false); } }}
      >
        <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 0, gap: 0 }}>
          <View style={styles.modalBody}>
            <Text style={styles.modalHeading}>View name</Text>
            <TextInput
              accessibilityLabel="View name"
              autoFocus
              onChangeText={(value) => { setViewNameDraft(value); setViewError(""); }}
              placeholder="e.g. Client projects"
              placeholderTextColor={colors.foregroundMuted}
              style={styles.modalInput}
              value={viewNameDraft}
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={styles.modalHeading}>Projects</Text>
              <Text style={styles.modalHint}>{viewProjectIds.length} selected</Text>
            </View>
            <TextInput
              accessibilityLabel="Search projects"
              onChangeText={setProjectSearch}
              placeholder="Search projects..."
              placeholderTextColor={colors.foregroundMuted}
              style={styles.projectSearch}
              value={projectSearch}
            />
            <PluginScrollView style={{ flex: 1, minHeight: 120, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
              {filteredProjects.map((project) => {
                const selected = viewProjectIds.includes(project.projectId);
                return (
                  <Pressable
                    key={project.projectId}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    onPress={() => toggleProject(project.projectId)}
                    style={styles.projectRow}
                  >
                    <View style={[styles.projectMark, selected && styles.projectMarkSelected]}>
                      {selected ? <Text style={{ color: colors.accentForeground, fontSize: 10, fontWeight: "700" }}>✓</Text> : null}
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text numberOfLines={1} style={styles.projectLabel}>{projectTitle(project)}</Text>
                      <Text numberOfLines={1} style={styles.projectPath}>{project.projectRootPath}</Text>
                    </View>
                  </Pressable>
                );
              })}
              {!filteredProjects.length ? <Text style={[styles.empty, { padding: 12 }]}>No projects found.</Text> : null}
            </PluginScrollView>
            {viewError ? <Text style={styles.dangerText}>{viewError}</Text> : null}
            {confirmDelete ? <Text style={styles.dangerText}>Select Delete view again to remove this saved view.</Text> : null}
            <View style={styles.modalFooter}>
              {editingViewId ? (
                <Pressable accessibilityRole="button" onPress={() => void deleteView()} style={[styles.modalButton, styles.modalButtonDanger]}>
                  <Text style={styles.dangerText}>{confirmDelete ? "Confirm delete" : "Delete view"}</Text>
                </Pressable>
              ) : null}
              <View style={styles.footerSpacer} />
              <Pressable accessibilityRole="button" onPress={() => setViewModalOpen(false)} style={styles.modalButton}>
                <Text style={styles.modalButtonText}>Cancel</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={settings.status !== "ready" || settings.saving} onPress={() => void saveView()} style={[styles.modalButton, styles.modalButtonPrimary]}>
                <Text style={styles.modalButtonPrimaryText}>{settings.saving ? "Saving..." : "Save view"}</Text>
              </Pressable>
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
