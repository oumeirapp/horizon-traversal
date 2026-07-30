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

export interface IssueCounts {
  warnings: number;
  errors: number;
}

export type StageIssueCounts = Record<PipelineStage, IssueCounts>;

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
  stageIssues: StageIssueCounts;
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
  unscopedWarnings: number;
  unscopedErrors: number;
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
    unscopedWarnings: 0,
    unscopedErrors: 0,
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
    stageIssues: {
      discover: { warnings: 0, errors: 0 },
      copy: { warnings: 0, errors: 0 },
      pdf: { warnings: 0, errors: 0 },
      images: { warnings: 0, errors: 0 },
      video: { warnings: 0, errors: 0 },
      report: { warnings: 0, errors: 0 },
    },
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

function normalizeTicketStatus(
  status: TicketStatus,
  errors: number,
): TicketStatus {
  if (errors === 0) return "success";
  return status === "failed" ? "failed" : "partialSuccess";
}

function normalizeSummary(
  summary: PipelineSummary,
  tickets: TicketProgress[],
): PipelineSummary {
  let successfulTickets = summary.successfulTickets;
  let partialTickets = summary.partialTickets;
  let failedTickets = summary.failedTickets;
  const completedTickets = tickets.filter((ticket) => ticket.status !== null);

  if (summary.errors === 0) {
    successfulTickets = summary.totalTickets;
    partialTickets = 0;
    failedTickets = 0;
  } else if (
    summary.totalTickets > 0 &&
    completedTickets.length === summary.totalTickets
  ) {
    successfulTickets = 0;
    partialTickets = 0;
    failedTickets = 0;
    for (const ticket of completedTickets) {
      if (ticket.status === "success") successfulTickets += 1;
      else if (ticket.status === "partialSuccess") partialTickets += 1;
      else failedTickets += 1;
    }
  }

  const hasIssues = summary.errors > 0;
  const status: RunStatus = !hasIssues
    ? "success"
    : successfulTickets + partialTickets > 0
      ? "partialSuccess"
      : "failed";

  if (
    status === summary.status &&
    successfulTickets === summary.successfulTickets &&
    partialTickets === summary.partialTickets &&
    failedTickets === summary.failedTickets
  ) {
    return summary;
  }

  return {
    ...summary,
    status,
    successfulTickets,
    partialTickets,
    failedTickets,
  };
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
        if (event.level === "warning" || event.level === "error") {
          const warning = event.level === "warning" ? 1 : 0;
          const error = event.level === "error" ? 1 : 0;
          if (event.ticket === null) {
            next = {
              ...next,
              unscopedWarnings: next.unscopedWarnings + warning,
              unscopedErrors: next.unscopedErrors + error,
            };
          } else {
            next = {
              ...next,
              tickets: updateTicket(next.tickets, event.ticket, (ticket) => {
                if (ticket.stage === null) {
                  return {
                    ...ticket,
                    warnings: ticket.warnings + warning,
                    errors: ticket.errors + error,
                  };
                }

                const stage = ticket.stage;
                const stageIssues = ticket.stageIssues[stage];
                return {
                  ...ticket,
                  warnings: ticket.warnings + warning,
                  errors: ticket.errors + error,
                  stageIssues: {
                    ...ticket.stageIssues,
                    [stage]: {
                      warnings: stageIssues.warnings + warning,
                      errors: stageIssues.errors + error,
                    },
                  },
                };
              }),
            };
          }
        }
        break;
      case "ticketCompleted":
        next = {
          ...next,
          tickets: updateTicket(next.tickets, event.ticket, (ticket) => ({
            ...ticket,
            status: normalizeTicketStatus(
              event.status,
              event.errors,
            ),
            copiedFiles: event.copiedFiles,
            changedFiles: event.changedFiles,
            failedFiles: event.failedFiles,
            // Completion totals are authoritative and replace the provisional
            // counts derived from live log events.
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
    case "resolved": {
      const summary = normalizeSummary(action.summary, state.tickets);
      return {
        ...state,
        phase: summary.status,
        summary,
        finishedAt: action.finishedAt,
      };
    }
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
