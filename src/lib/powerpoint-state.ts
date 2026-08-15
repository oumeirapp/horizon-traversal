import type {
  PowerPointEvent,
  PowerPointStep,
  PowerPointSummary,
} from "./native";
import type { RunLogEntry } from "./run-state";

export const MAX_POWERPOINT_LOG_ENTRIES = 10_000;

export type PowerPointPhase =
  | "idle"
  | "running"
  | "cancelling"
  | PowerPointSummary["status"];

export interface PowerPointRunState {
  phase: PowerPointPhase;
  runId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  currentTicket: string | null;
  currentIndex: number;
  totalTickets: number;
  currentStep: PowerPointStep | null;
  stepCompleted: number;
  stepTotal: number;
  completedUnits: number;
  totalUnits: number;
  message: string | null;
  logs: RunLogEntry[];
  nextLogId: number;
  summary: PowerPointSummary | null;
  fatalError: string | null;
  cancelError: string | null;
}

export type PowerPointRunAction =
  | { type: "start"; startedAt: number }
  | { type: "event"; event: PowerPointEvent }
  | { type: "events"; events: PowerPointEvent[] }
  | { type: "resolved"; summary: PowerPointSummary; finishedAt: number }
  | { type: "rejected"; message: string; finishedAt: number }
  | { type: "cancelRequested" }
  | { type: "cancelRejected"; message: string }
  | { type: "reset" };

export function createInitialPowerPointRunState(): PowerPointRunState {
  return {
    phase: "idle",
    runId: null,
    startedAt: null,
    finishedAt: null,
    currentTicket: null,
    currentIndex: 0,
    totalTickets: 0,
    currentStep: null,
    stepCompleted: 0,
    stepTotal: 0,
    completedUnits: 0,
    totalUnits: 0,
    message: null,
    logs: [],
    nextLogId: 1,
    summary: null,
    fatalError: null,
    cancelError: null,
  };
}

function completionPhase(summary: PowerPointSummary): PowerPointPhase {
  return summary.status;
}

export function reducePowerPointEvents(
  state: PowerPointRunState,
  events: PowerPointEvent[],
): PowerPointRunState {
  let next = state;
  let pendingLogs: RunLogEntry[] | null = null;
  let nextLogId = state.nextLogId;

  for (const event of events) {
    if (event.type === "powerpointStarted") {
      if (next.runId !== null && event.runId !== next.runId) continue;
      next = {
        ...next,
        runId: event.runId,
        totalTickets: event.totalTickets,
        totalUnits: event.totalUnits,
      };
      continue;
    }

    if (next.runId !== null && event.runId !== next.runId) continue;

    if (event.type === "powerpointProgress") {
      next = {
        ...next,
        runId: event.runId,
        currentStep: event.step,
        currentTicket: event.ticket,
        currentIndex: event.index ?? 0,
        totalTickets: event.totalTickets,
        stepCompleted: event.stepCompleted,
        stepTotal: event.stepTotal,
        completedUnits: event.completedUnits,
        totalUnits: event.totalUnits,
        message: event.message,
      };
      continue;
    }

    if (event.type === "log") {
      pendingLogs ??= [];
      pendingLogs.push({
        id: nextLogId,
        ticket: event.ticket,
        level: event.level,
        message: event.message,
        path: event.path,
        timestampMs: event.timestampMs,
      });
      nextLogId += 1;
      if (next.runId === null) next = { ...next, runId: event.runId };
      continue;
    }

    next = {
      ...next,
      phase: completionPhase(event.summary),
      runId: event.runId,
      summary: event.summary,
      totalTickets: event.summary.totalTickets,
      fatalError: null,
      cancelError: null,
    };
  }

  if (pendingLogs !== null) {
    const logs = [...next.logs, ...pendingLogs];
    next = {
      ...next,
      logs:
        logs.length > MAX_POWERPOINT_LOG_ENTRIES
          ? logs.slice(logs.length - MAX_POWERPOINT_LOG_ENTRIES)
          : logs,
      nextLogId,
    };
  }

  return next;
}

export function powerPointRunReducer(
  state: PowerPointRunState,
  action: PowerPointRunAction,
): PowerPointRunState {
  switch (action.type) {
    case "start":
      return {
        ...createInitialPowerPointRunState(),
        phase: "running",
        startedAt: action.startedAt,
      };
    case "event":
      return reducePowerPointEvents(state, [action.event]);
    case "events":
      return reducePowerPointEvents(state, action.events);
    case "resolved":
      return {
        ...state,
        phase: completionPhase(action.summary),
        finishedAt: action.finishedAt,
        totalTickets: action.summary.totalTickets,
        summary: action.summary,
        fatalError: null,
        cancelError: null,
      };
    case "rejected":
      return {
        ...state,
        phase: "failed",
        finishedAt: action.finishedAt,
        fatalError: action.message,
        cancelError: null,
      };
    case "cancelRequested":
      return { ...state, phase: "cancelling", cancelError: null };
    case "cancelRejected":
      return state.phase !== "cancelling"
        ? state
        : { ...state, phase: "running", cancelError: action.message };
    case "reset":
      return createInitialPowerPointRunState();
  }
}
