import { describe, expect, it } from "vitest";
import type { PipelineEvent, PipelineSummary } from "./native";
import {
  MAX_LOG_ENTRIES,
  createInitialRunState,
  reducePipelineEvents,
  runReducer,
} from "./run-state";

const successSummary: PipelineSummary = {
  status: "success",
  totalTickets: 1,
  successfulTickets: 1,
  partialTickets: 0,
  failedTickets: 0,
  copiedFiles: 3,
  changedFiles: 2,
  failedFiles: 0,
  warnings: 0,
  errors: 0,
  elapsedMs: 1200,
  outputPath: "/out",
};

describe("run state", () => {
  it("tracks ticket and stage progress from a batched event stream", () => {
    const started = runReducer(createInitialRunState(), {
      type: "start",
      startedAt: 100,
    });
    const events: PipelineEvent[] = [
      { type: "pipelineStarted", totalTickets: 1 },
      { type: "ticketStarted", ticket: "P7", index: 1, totalTickets: 1 },
      { type: "stageChanged", ticket: "P7", stage: "copy" },
      {
        type: "ticketCompleted",
        ticket: "P7",
        status: "success",
        copiedFiles: 3,
        changedFiles: 2,
        failedFiles: 0,
        warnings: 0,
        errors: 0,
        elapsedMs: 1200,
      },
      { type: "pipelineCompleted", summary: successSummary },
    ];
    const streamed = reducePipelineEvents(started, events);

    expect(streamed.phase).toBe("running");
    expect(streamed.summary).toBeNull();
    expect(streamed.currentTicket).toBe("P7");
    expect(streamed.currentStage).toBe("copy");
    expect(streamed.tickets[0]).toMatchObject({
      name: "P7",
      status: "success",
      copiedFiles: 3,
    });

    const resolved = runReducer(streamed, {
      type: "resolved",
      summary: successSummary,
      finishedAt: 1400,
    });
    expect(resolved.phase).toBe("success");
    expect(resolved.summary).toBe(successSummary);
  });

  it("retains only the newest 10,000 structured log entries", () => {
    const events: PipelineEvent[] = Array.from(
      { length: MAX_LOG_ENTRIES + 5 },
      (_, index) => ({
        type: "log" as const,
        ticket: null,
        level: "info" as const,
        message: `Entry ${index}`,
        path: null,
        timestampMs: index,
      }),
    );

    const state = reducePipelineEvents(createInitialRunState(), events);
    expect(state.logs).toHaveLength(MAX_LOG_ENTRIES);
    expect(state.logs[0].message).toBe("Entry 5");
    expect(state.logs[MAX_LOG_ENTRIES - 1].message).toBe("Entry 10004");
  });

  it("represents invocation failures even when no channel event arrived", () => {
    const state = runReducer(
      runReducer(createInitialRunState(), { type: "start", startedAt: 100 }),
      { type: "rejected", message: "Native run unavailable", finishedAt: 110 },
    );

    expect(state.phase).toBe("failed");
    expect(state.fatalError).toBe("Native run unavailable");
    expect(state.logs).toHaveLength(0);
  });

  it("does not let a delayed channel batch replace the command result", () => {
    const resolved = runReducer(
      runReducer(createInitialRunState(), { type: "start", startedAt: 100 }),
      { type: "resolved", summary: successSummary, finishedAt: 200 },
    );

    const afterDelayedEvents = reducePipelineEvents(resolved, [
      { type: "pipelineStarted", totalTickets: 1 },
      { type: "ticketStarted", ticket: "P1", index: 1, totalTickets: 1 },
      { type: "stageChanged", ticket: "P1", stage: "report" },
    ]);

    expect(afterDelayedEvents.phase).toBe("success");
    expect(afterDelayedEvents.summary).toBe(successSummary);
    expect(afterDelayedEvents.currentStage).toBe("report");
  });
});
