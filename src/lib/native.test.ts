import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  openLastOutput,
  startPipeline,
  validateSelection,
  type PipelineEvent,
  type PipelineStage,
  type PipelineSummary,
  type SelectionRequest,
  type SelectionSummary,
  type TicketStatus,
} from "./native";

interface MockChannel<T> {
  onmessage: (message: T) => void;
}

const tauriMock = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as MockChannel<unknown>[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMock.invoke,
  Channel: class<T> implements MockChannel<T> {
    onmessage = (_message: T) => undefined;

    constructor() {
      tauriMock.channels.push(this as MockChannel<unknown>);
    }
  },
}));

const request: SelectionRequest = {
  inputPath: "/tickets",
  outputPath: "/exports",
  ticketFilter: "P1-P3",
};

const selection: SelectionSummary = {
  valid: true,
  inputPath: "/tickets",
  outputPath: "/exports",
  tickets: [{ name: "P1 Example", path: "/tickets/P1 Example" }],
  warnings: [],
  issues: [],
};

const summary: PipelineSummary = {
  status: "success",
  totalTickets: 1,
  successfulTickets: 1,
  partialTickets: 0,
  failedTickets: 0,
  copiedFiles: 2,
  changedFiles: 1,
  failedFiles: 0,
  warnings: 0,
  errors: 0,
  elapsedMs: 1250,
  outputPath: "/exports",
};

describe("native Tauri boundary", () => {
  beforeEach(() => {
    tauriMock.invoke.mockReset();
    tauriMock.channels.length = 0;
  });

  it("invokes selection validation with the typed request", async () => {
    tauriMock.invoke.mockResolvedValue(selection);

    await expect(validateSelection(request)).resolves.toBe(selection);
    expect(tauriMock.invoke).toHaveBeenCalledWith("validate_selection", {
      request,
    });
  });

  it("streams pipeline channel messages to the supplied handler", async () => {
    const onEvent = vi.fn<(event: PipelineEvent) => void>();
    const event: PipelineEvent = {
      type: "stageChanged",
      ticket: "P1 Example",
      stage: "images",
    };
    tauriMock.invoke.mockResolvedValue(summary);

    const result = startPipeline(request, onEvent);
    const channel = tauriMock.channels[0] as MockChannel<PipelineEvent>;
    channel.onmessage(event);

    await expect(result).resolves.toBe(summary);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(event);
    expect(tauriMock.invoke).toHaveBeenCalledWith("start_pipeline", {
      request,
      onEvent: channel,
    });
  });

  it("invokes the Rust-owned open-output command without path arguments", async () => {
    tauriMock.invoke.mockResolvedValue(undefined);

    await expect(openLastOutput()).resolves.toBeUndefined();
    expect(tauriMock.invoke).toHaveBeenCalledWith("open_last_output");
  });

  it("exposes the intended public TypeScript contract", () => {
    expectTypeOf(validateSelection).returns.toEqualTypeOf<
      Promise<SelectionSummary>
    >();
    expectTypeOf(startPipeline).returns.toEqualTypeOf<
      Promise<PipelineSummary>
    >();
    expectTypeOf<PipelineStage>().toEqualTypeOf<
      "discover" | "copy" | "pdf" | "images" | "video" | "report"
    >();
    expectTypeOf<TicketStatus>().toEqualTypeOf<
      "success" | "partialSuccess" | "failed"
    >();
  });
});
