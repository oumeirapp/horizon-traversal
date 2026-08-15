import { describe, expect, it } from "vitest";
import type { PowerPointEvent, PowerPointSummary } from "./native";
import {
  MAX_POWERPOINT_LOG_ENTRIES,
  createInitialPowerPointRunState,
  powerPointRunReducer,
  reducePowerPointEvents,
} from "./powerpoint-state";

const successSummary: PowerPointSummary = {
  status: "success",
  totalTickets: 2,
  slidesCreated: 2,
  blankSlides: 0,
  warnings: 0,
  errors: 0,
  elapsedMs: 1_200,
  outputPath: "/presentations/Horizon Traversal.pptx",
  reportPath: "/presentations/Horizon Traversal.layout-report.json",
};

function runningState() {
  return reducePowerPointEvents(
    powerPointRunReducer(createInitialPowerPointRunState(), {
      type: "start",
      startedAt: 100,
    }),
    [
      {
        type: "powerpointStarted",
        runId: "pptx-1",
        totalTickets: 2,
        totalUnits: 10,
      },
    ],
  );
}

describe("PowerPoint run state", () => {
  it("reduces progress and logs as one event batch", () => {
    const state = reducePowerPointEvents(runningState(), [
      {
        type: "powerpointProgress",
        runId: "pptx-1",
        step: "compose",
        ticket: "P2 Brand",
        index: 2,
        totalTickets: 2,
        stepCompleted: 1,
        stepTotal: 2,
        completedUnits: 6,
        totalUnits: 10,
        message: "Composing the second slide",
      },
      {
        type: "log",
        runId: "pptx-1",
        ticket: "P2 Brand",
        level: "info",
        message: "Selected deliverables",
        path: null,
        timestampMs: 200,
      },
      {
        type: "log",
        runId: "pptx-1",
        ticket: "P2 Brand",
        level: "warning",
        message: "Viewer compatibility may vary",
        path: "/tickets/P2/video.avi",
        timestampMs: 201,
      },
    ]);

    expect(state).toMatchObject({
      phase: "running",
      runId: "pptx-1",
      currentStep: "compose",
      currentTicket: "P2 Brand",
      currentIndex: 2,
      completedUnits: 6,
      message: "Composing the second slide",
      nextLogId: 3,
    });
    expect(state.logs.map((entry) => entry.message)).toEqual([
      "Selected deliverables",
      "Viewer compatibility may vary",
    ]);
  });

  it("retains only the newest bounded PowerPoint log entries", () => {
    const events: PowerPointEvent[] = Array.from(
      { length: MAX_POWERPOINT_LOG_ENTRIES + 5 },
      (_, index) => ({
        type: "log" as const,
        runId: "pptx-1",
        ticket: null,
        level: "info" as const,
        message: `Entry ${index}`,
        path: null,
        timestampMs: index,
      }),
    );

    const state = reducePowerPointEvents(runningState(), events);
    expect(state.logs).toHaveLength(MAX_POWERPOINT_LOG_ENTRIES);
    expect(state.logs[0].message).toBe("Entry 5");
    expect(state.logs[MAX_POWERPOINT_LOG_ENTRIES - 1].message).toBe(
      "Entry 10004",
    );
  });

  it("does not let a late cancellation rejection resurrect a terminal run", () => {
    const cancelling = powerPointRunReducer(runningState(), {
      type: "cancelRequested",
    });
    const completed = reducePowerPointEvents(cancelling, [
      {
        type: "powerpointCompleted",
        runId: "pptx-1",
        summary: successSummary,
      },
    ]);
    const afterLateRejection = powerPointRunReducer(completed, {
      type: "cancelRejected",
      message: "The PowerPoint run is no longer active.",
    });

    expect(afterLateRejection).toBe(completed);
    expect(afterLateRejection.phase).toBe("success");
    expect(afterLateRejection.cancelError).toBeNull();
    expect(afterLateRejection.summary).toBe(successSummary);

    const reset = powerPointRunReducer(completed, { type: "reset" });
    expect(
      powerPointRunReducer(reset, {
        type: "cancelRejected",
        message: "The PowerPoint run is no longer active.",
      }),
    ).toBe(reset);
  });

  it("returns to running when cancellation genuinely fails mid-run", () => {
    const state = powerPointRunReducer(
      powerPointRunReducer(runningState(), { type: "cancelRequested" }),
      {
        type: "cancelRejected",
        message: "Could not write the cancellation marker.",
      },
    );

    expect(state.phase).toBe("running");
    expect(state.cancelError).toBe(
      "Could not write the cancellation marker.",
    );
  });
});
