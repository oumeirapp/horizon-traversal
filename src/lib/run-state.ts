import type {
  LogLevel,
  PipelineEvent,
  PipelineStage,
  PipelineSummary,
  RunStatus,
  TicketStatus,
} from "./native";

export const MAX_LOG_ENTRIES = 10_000;

export type RunPhase = "idle" | "running" | RunStatus;

export interface RunLogEntry {
  id: number;
  ticket: string | null;
  level: LogLevel;
  message: string;
  path: string | null;
  timestampMs: number;
}

export interface TicketProgress {
  name: string;
  index: number;
  stage: PipelineStage | null;
  status: TicketStatus | null;
  copiedFiles: number;
  changedFiles: number;
  failedFiles: number;
  warnings: number;
  errors: number;
  elapsedMs: number;
}

export interface RunState {
  phase: RunPhase;
  startedAt: number | null;
  finishedAt: number | null;
  currentTicket: string | null;
  currentIndex: number;
  totalTickets: number;
  currentStage: PipelineStage | null;
  tickets: TicketProgress[];
  logs: RunLogEntry[];
  summary: PipelineSummary | null;
  fatalError: string | null;
  nextLogId: number;
}

export type RunAction =
  | { type: "start"; startedAt: number }
  | { type: "events"; events: PipelineEvent[] }
  | { type: "resolved"; summary: PipelineSummary; finishedAt: number }
  | { type: "rejected"; message: string; finishedAt: number }
  | { type: "reset" };

export function createInitialRunState(): RunState {
  return {
    phase: "idle",
    startedAt: null,
    finishedAt: null,
    currentTicket: null,
    currentIndex: 0,
    totalTickets: 0,
    currentStage: null,
    tickets: [],
    logs: [],
    summary: null,
    fatalError: null,
    nextLogId: 1,
  };
}

function emptyTicket(name: string, index: number): TicketProgress {
  return {
    name,
    index,
    stage: null,
    status: null,
    copiedFiles: 0,
    changedFiles: 0,
    failedFiles: 0,
    warnings: 0,
    errors: 0,
    elapsedMs: 0,
  };
}

function updateTicket(
  tickets: TicketProgress[],
  name: string,
  update: (ticket: TicketProgress) => TicketProgress,
  fallbackIndex = tickets.length + 1,
): TicketProgress[] {
  const index = tickets.findIndex((ticket) => ticket.name === name);
  if (index === -1) {
    return [...tickets, update(emptyTicket(name, fallbackIndex))];
  }

  const next = tickets.slice();
  next[index] = update(tickets[index]);
  return next;
}

export function reducePipelineEvents(
  state: RunState,
  events: PipelineEvent[],
): RunState {
  let next = state;
  let pendingLogs: RunLogEntry[] | null = null;
  let nextLogId = state.nextLogId;

  for (const event of events) {
    switch (event.type) {
      case "pipelineStarted":
        next = {
          ...next,
          totalTickets: event.totalTickets,
        };
        break;
      case "ticketStarted":
        next = {
          ...next,
          currentTicket: event.ticket,
          currentIndex: event.index,
          currentStage: null,
          totalTickets: event.totalTickets,
          tickets: updateTicket(
            next.tickets,
            event.ticket,
            (ticket) => ({ ...ticket, index: event.index }),
            event.index,
          ),
        };
        break;
      case "stageChanged":
        next = {
          ...next,
          currentTicket: event.ticket,
          currentStage: event.stage,
          tickets: updateTicket(next.tickets, event.ticket, (ticket) => ({
            ...ticket,
            stage: event.stage,
          })),
        };
        break;
      case "log":
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
        break;
      case "ticketCompleted":
        next = {
          ...next,
          tickets: updateTicket(next.tickets, event.ticket, (ticket) => ({
            ...ticket,
            status: event.status,
            copiedFiles: event.copiedFiles,
            changedFiles: event.changedFiles,
            failedFiles: event.failedFiles,
            warnings: event.warnings,
            errors: event.errors,
            elapsedMs: event.elapsedMs,
          })),
        };
        break;
      case "pipelineCompleted":
        // The command result is the terminal authority. Keeping channel events
        // observational prevents a delayed completion message from replacing
        // the summary returned for a newer run.
        break;
    }
  }

  if (pendingLogs !== null) {
    const logs = [...next.logs, ...pendingLogs];
    next = {
      ...next,
      logs:
        logs.length > MAX_LOG_ENTRIES
          ? logs.slice(logs.length - MAX_LOG_ENTRIES)
          : logs,
      nextLogId,
    };
  }

  return next;
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "start":
      return {
        ...createInitialRunState(),
        phase: "running",
        startedAt: action.startedAt,
      };
    case "events":
      return reducePipelineEvents(state, action.events);
    case "resolved":
      return {
        ...state,
        phase: action.summary.status,
        summary: action.summary,
        finishedAt: action.finishedAt,
      };
    case "rejected":
      return {
        ...state,
        phase: "failed",
        fatalError: action.message,
        finishedAt: action.finishedAt,
      };
    case "reset":
      return createInitialRunState();
  }
}
