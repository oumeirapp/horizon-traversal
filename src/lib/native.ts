import { Channel, invoke } from "@tauri-apps/api/core";

export type AppTheme = "dark" | "light";

export interface AppSettings {
  defaultOutputPath: string;
  powerpointOutputPath: string;
  theme: AppTheme;
}

export interface SelectionRequest {
  inputPath: string;
  outputPath: string;
  ticketFilter: string;
  processingOptions: ProcessingOptions;
}

export interface PowerPointRequest {
  inputPath: string;
  outputPath: string;
}

export interface ProcessingOptions {
  pdf: boolean;
  images: boolean;
  video: boolean;
}

export interface ValidationIssue {
  field: "input" | "output" | "filter" | "selection" | "general";
  code: string;
  message: string;
}

export interface TicketMatch {
  name: string;
  path: string;
}

export interface SelectionSummary {
  valid: boolean;
  inputPath: string;
  outputPath: string;
  tickets: TicketMatch[];
  warnings: string[];
  issues: ValidationIssue[];
}

export type PipelineStage =
  | "discover"
  | "copy"
  | "pdf"
  | "images"
  | "video"
  | "report";

export type LogLevel = "info" | "success" | "warning" | "error";

export type RunStatus = "success" | "partialSuccess" | "failed";

export type TicketStatus = RunStatus;

export type PowerPointStep =
  | "inspect"
  | "video"
  | "layout"
  | "compose"
  | "save";

export type PowerPointRunStatus = RunStatus | "cancelled";

export interface PowerPointSummary {
  status: PowerPointRunStatus;
  totalTickets: number;
  slidesCreated: number;
  blankSlides: number;
  warnings: number;
  errors: number;
  elapsedMs: number;
  outputPath: string | null;
  reportPath: string | null;
}

export type PowerPointEvent =
  | {
      type: "powerpointStarted";
      runId: string;
      totalTickets: number;
      totalUnits: number;
    }
  | {
      type: "powerpointProgress";
      runId: string;
      step: PowerPointStep;
      ticket: string | null;
      index: number | null;
      totalTickets: number;
      stepCompleted: number;
      stepTotal: number;
      completedUnits: number;
      totalUnits: number;
      message: string;
    }
  | {
      type: "log";
      runId: string;
      ticket: string | null;
      level: LogLevel;
      message: string;
      path: string | null;
      timestampMs: number;
    }
  | {
      type: "powerpointCompleted";
      runId: string;
      summary: PowerPointSummary;
    };

export interface PipelineSummary {
  status: RunStatus;
  totalTickets: number;
  successfulTickets: number;
  partialTickets: number;
  failedTickets: number;
  copiedFiles: number;
  changedFiles: number;
  failedFiles: number;
  warnings: number;
  errors: number;
  elapsedMs: number;
  outputPath: string;
}

export type PipelineEvent =
  | {
      type: "pipelineStarted";
      totalTickets: number;
    }
  | {
      type: "ticketStarted";
      ticket: string;
      index: number;
      totalTickets: number;
    }
  | {
      type: "stageChanged";
      ticket: string;
      stage: PipelineStage;
    }
  | {
      type: "log";
      ticket: string | null;
      level: LogLevel;
      message: string;
      path: string | null;
      timestampMs: number;
    }
  | {
      type: "ticketCompleted";
      ticket: string;
      status: TicketStatus;
      copiedFiles: number;
      changedFiles: number;
      failedFiles: number;
      warnings: number;
      errors: number;
      elapsedMs: number;
    }
  | {
      type: "pipelineCompleted";
      summary: PipelineSummary;
    };

export function validateSelection(
  request: SelectionRequest,
): Promise<SelectionSummary> {
  return invoke<SelectionSummary>("validate_selection", { request });
}

export function validatePowerPointSelection(
  request: PowerPointRequest,
): Promise<SelectionSummary> {
  return invoke<SelectionSummary>("validate_powerpoint_selection", { request });
}

export function startPipeline(
  request: SelectionRequest,
  onEvent: (event: PipelineEvent) => void,
): Promise<PipelineSummary> {
  const channel = new Channel<PipelineEvent>();
  channel.onmessage = onEvent;

  return invoke<PipelineSummary>("start_pipeline", {
    request,
    onEvent: channel,
  });
}

export function startPowerPoint(
  request: PowerPointRequest,
  onEvent: (event: PowerPointEvent) => void,
): Promise<PowerPointSummary> {
  const channel = new Channel<PowerPointEvent>();
  channel.onmessage = onEvent;

  return invoke<PowerPointSummary>("start_powerpoint", {
    request,
    onEvent: channel,
  });
}

export function cancelPowerPoint(runId: string): Promise<void> {
  return invoke<void>("cancel_powerpoint", { runId });
}

export function openPowerPointOutput(): Promise<void> {
  return invoke<void>("open_powerpoint_output");
}

export function openLastOutput(): Promise<void> {
  return invoke<void>("open_last_output");
}

export function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("save_settings", { settings });
}
