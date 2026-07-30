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

const warningOnlySummary: PipelineSummary = {
  ...successSummary,
  status: "partialSuccess",
  successfulTickets: 0,
  partialTickets: 1,
  warnings: 1,
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

  it("tracks live stage issues and replaces provisional ticket totals on completion", () => {
    const state = reducePipelineEvents(createInitialRunState(), [
      {
        type: "log",
        ticket: null,
        level: "warning",
        message: "Run-level warning",
        path: null,
        timestampMs: 99,
      },
      { type: "ticketStarted", ticket: "P8", index: 1, totalTickets: 1 },
      { type: "stageChanged", ticket: "P8", stage: "images" },
      {
        type: "log",
        ticket: "P8",
        level: "warning",
        message: "Image was already within bounds",
        path: null,
        timestampMs: 100,
      },
      {
        type: "log",
        ticket: "P8",
        level: "error",
        message: "Could not resize one image",
        path: null,
        timestampMs: 101,
      },
    ]);

    expect(state.tickets[0]).toMatchObject({ warnings: 1, errors: 1 });
    expect(state.unscopedWarnings).toBe(1);
    expect(state.tickets[0].stageIssues.images).toEqual({
      warnings: 1,
      errors: 1,
    });

    const completed = reducePipelineEvents(state, [
      {
        type: "ticketCompleted",
        ticket: "P8",
        status: "partialSuccess",
        copiedFiles: 2,
        changedFiles: 0,
        failedFiles: 1,
        warnings: 3,
        errors: 2,
        elapsedMs: 500,
      },
    ]);

    expect(completed.tickets[0]).toMatchObject({ warnings: 3, errors: 2 });
    expect(completed.tickets[0].stageIssues.images).toEqual({
      warnings: 1,
      errors: 1,
    });
  });

  it("promotes warning-only ticket and run outcomes to success", () => {
    const streamed = reducePipelineEvents(createInitialRunState(), [
      { type: "pipelineStarted", totalTickets: 1 },
      { type: "ticketStarted", ticket: "P9", index: 1, totalTickets: 1 },
      { type: "stageChanged", ticket: "P9", stage: "copy" },
      {
        type: "log",
        ticket: "P9",
        level: "warning",
        message: "Skipped an unsupported file",
        path: null,
        timestampMs: 100,
      },
      {
        type: "ticketCompleted",
        ticket: "P9",
        status: "partialSuccess",
        copiedFiles: 3,
        changedFiles: 2,
        failedFiles: 0,
        warnings: 1,
        errors: 0,
        elapsedMs: 1_200,
      },
    ]);

    expect(streamed.tickets[0]).toMatchObject({
      status: "success",
      warnings: 1,
      errors: 0,
    });

    const resolved = runReducer(streamed, {
      type: "resolved",
      summary: warningOnlySummary,
      finishedAt: 1_300,
    });

    expect(resolved.phase).toBe("success");
    expect(resolved.summary).toMatchObject({
      status: "success",
      successfulTickets: 1,
      partialTickets: 0,
      failedTickets: 0,
      warnings: 1,
      errors: 0,
    });
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
