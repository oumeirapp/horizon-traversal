import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  loadSettings,
  openLastOutput,
  saveSettings,
  startPipeline,
  validateSelection,
  type AppSettings,
  type AppTheme,
  type PipelineEvent,
  type PipelineStage,
  type PipelineSummary,
  type ProcessingOptions,
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
  processingOptions: {
    pdf: true,
    images: false,
    video: true,
  },
};

const appSettings: AppSettings = {
  defaultOutputPath: "/exports",
  powerpointOutputPath: "/presentations",
  theme: "dark",
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

  it("loads the persisted application settings", async () => {
    tauriMock.invoke.mockResolvedValue(appSettings);

    await expect(loadSettings()).resolves.toBe(appSettings);
    expect(tauriMock.invoke).toHaveBeenCalledWith("load_settings");
  });

  it("saves the complete settings object and returns the normalized result", async () => {
    const normalized = {
      ...appSettings,
      defaultOutputPath: "/exports/normalized",
      theme: "light" as const,
    };
    tauriMock.invoke.mockResolvedValue(normalized);

    await expect(saveSettings(appSettings)).resolves.toBe(normalized);
    expect(tauriMock.invoke).toHaveBeenCalledWith("save_settings", {
      settings: appSettings,
    });
  });

  it("exposes the intended public TypeScript contract", () => {
    expectTypeOf(validateSelection).returns.toEqualTypeOf<
      Promise<SelectionSummary>
    >();
    expectTypeOf(startPipeline).returns.toEqualTypeOf<
      Promise<PipelineSummary>
    >();
    expectTypeOf(loadSettings).returns.toEqualTypeOf<Promise<AppSettings>>();
    expectTypeOf(saveSettings).returns.toEqualTypeOf<Promise<AppSettings>>();
    expectTypeOf<AppSettings["theme"]>().toEqualTypeOf<AppTheme>();
    expectTypeOf<AppSettings["powerpointOutputPath"]>().toEqualTypeOf<string>();
    expectTypeOf<AppTheme>().toEqualTypeOf<"dark" | "light">();
    expectTypeOf<PipelineStage>().toEqualTypeOf<
      "discover" | "copy" | "pdf" | "images" | "video" | "report"
    >();
    expectTypeOf<TicketStatus>().toEqualTypeOf<
      "success" | "partialSuccess" | "failed"
    >();
    expectTypeOf<SelectionRequest["processingOptions"]>().toEqualTypeOf<
      ProcessingOptions
    >();
  });
});
