use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tempfile::Builder;

use crate::pipeline::fs_safety::metadata_is_link_like;
use crate::pipeline::ipc::{AppError, LogLevel};
use crate::pipeline::videos::{MediaToolRunner, NativeTool, TauriMediaToolRunner, ToolOutput};

use super::ipc::{PowerPointEvent, PowerPointRunStatus, PowerPointStep, PowerPointSummary};
use super::scanner::{
    scan_ticket, ManifestAsset, ManifestDocument, ManifestTicket, ScannedTicket, SelectedVideo,
};
use super::state::{CancellationToken, PowerPointState};

const SIDECAR_NAME: &str = "powerpoint-sidecar";
const TEMPLATE_RESOURCE: &str = "powerpoint/Slide template.pptx";
const OUTPUT_NAME: &str = "Horizon Traversal.pptx";
const REPORT_NAME: &str = "Horizon Traversal.layout-report.json";
const CANCELLED_EXIT_CODE: i32 = 3;
const MAX_DIAGNOSTIC_BYTES: usize = 16_384;

pub trait PowerPointEventSink: Send + Sync {
    fn emit(&self, event: PowerPointEvent);
}

#[derive(Debug, Clone)]
pub struct PowerPointPlan {
    pub input: PathBuf,
    pub output: PathBuf,
    pub tickets: Vec<PathBuf>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarSummary {
    #[serde(default)]
    slides_created: usize,
    #[serde(default)]
    blank_slides: usize,
    #[serde(default)]
    warnings: usize,
}

#[derive(Debug, Default, Deserialize)]
struct ProbeDocument {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    format: ProbeFormat,
}

#[derive(Debug, Default, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<NumberOrString>,
}

#[derive(Debug, Default, Deserialize)]
struct ProbeFormat {
    format_name: Option<String>,
    duration: Option<NumberOrString>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum NumberOrString {
    Number(f64),
    String(String),
}

impl NumberOrString {
    fn value(&self) -> Option<f64> {
        match self {
            Self::Number(value) if value.is_finite() => Some(*value),
            Self::String(value) => value.parse().ok().filter(|value: &f64| value.is_finite()),
            Self::Number(_) => None,
        }
    }
}

#[derive(Debug)]
struct PreparedVideo {
    manifest: ManifestAsset,
    warnings: Vec<String>,
}

#[derive(Debug, Default)]
struct ProgressState {
    completed_units: usize,
    inspect_completed: usize,
    video_completed: usize,
    layout_completed: usize,
    compose_completed: usize,
    save_completed: usize,
}

#[derive(Debug, Clone, Copy)]
struct RunTotals {
    tickets: usize,
    units: usize,
    videos: usize,
}

impl ProgressState {
    fn completed_for(&self, step: PowerPointStep) -> usize {
        match step {
            PowerPointStep::Inspect => self.inspect_completed,
            PowerPointStep::Video => self.video_completed,
            PowerPointStep::Layout => self.layout_completed,
            PowerPointStep::Compose => self.compose_completed,
            PowerPointStep::Save => self.save_completed,
        }
    }

    fn advance(&mut self, step: PowerPointStep) {
        let counter = match step {
            PowerPointStep::Inspect => &mut self.inspect_completed,
            PowerPointStep::Video => &mut self.video_completed,
            PowerPointStep::Layout => &mut self.layout_completed,
            PowerPointStep::Compose => &mut self.compose_completed,
            PowerPointStep::Save => &mut self.save_completed,
        };
        *counter += 1;
        self.completed_units += 1;
    }
}

pub fn run_powerpoint(
    app: AppHandle,
    run_id: &str,
    plan: PowerPointPlan,
    cancellation: &CancellationToken,
    state: &PowerPointState,
    events: &impl PowerPointEventSink,
) -> Result<PowerPointSummary, AppError> {
    let started = Instant::now();
    fs::create_dir_all(&plan.output).map_err(|error| {
        AppError::new(
            "createPowerPointOutputFailed",
            format!("Cannot create the PowerPoint output folder: {error}"),
        )
    })?;
    let staging = Builder::new()
        .prefix(".horizon-powerpoint-")
        .tempdir_in(&plan.output)
        .map_err(|error| AppError::new("createPowerPointStagingFailed", error.to_string()))?;
    let cancel_path = staging.path().join("cancel.requested");
    state
        .attach_cancel_path(run_id, &cancel_path)
        .map_err(|error| AppError::new("powerPointCancellationUnavailable", error.to_string()))?;

    let mut scanned = Vec::with_capacity(plan.tickets.len());
    for ticket_path in &plan.tickets {
        let ticket_name = ticket_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let ticket = match scan_ticket(ticket_path) {
            Ok(ticket) => ticket,
            Err(error) => {
                let mut ticket = ScannedTicket::blank(
                    ticket_name.clone(),
                    format!("Ticket could not be inspected: {error}"),
                );
                ticket.warnings.push(error.to_string());
                ticket
            }
        };
        scanned.push(ticket);
    }

    let total_tickets = scanned.len();
    let video_total = scanned
        .iter()
        .map(|ticket| ticket.deliverable_videos.len())
        .sum::<usize>();
    let total_units = total_tickets.saturating_mul(3) + video_total + 2;
    events.emit(PowerPointEvent::PowerpointStarted {
        run_id: run_id.to_owned(),
        total_tickets,
        total_units,
    });

    let mut progress = ProgressState::default();
    let mut host_warning_count = 0_usize;
    let mut forwarded_host_warnings = 0_usize;
    for (offset, ticket) in scanned.iter().enumerate() {
        progress.advance(PowerPointStep::Inspect);
        emit_progress(
            events,
            run_id,
            PowerPointStep::Inspect,
            Some(&ticket.name),
            Some(offset + 1),
            total_tickets,
            progress.inspect_completed,
            total_tickets,
            progress.completed_units,
            total_units,
            if ticket.blank_reason.is_some() {
                "Prepared a blank slide"
            } else {
                "Selected ticket assets"
            },
        );
        for warning in &ticket.warnings {
            host_warning_count += 1;
            forwarded_host_warnings += 1;
            emit_log(
                events,
                run_id,
                Some(&ticket.name),
                LogLevel::Warning,
                warning.clone(),
                None,
            );
        }
    }

    if cancellation.is_cancelled() {
        return Ok(cancelled_summary(
            total_tickets,
            host_warning_count,
            started.elapsed(),
        ));
    }

    let media_tools = TauriMediaToolRunner::new(app.clone());
    let mut manifest_tickets = Vec::with_capacity(scanned.len());
    for (ticket_index, mut ticket) in scanned.into_iter().enumerate() {
        let mut prepared_videos = Vec::new();
        let mut prepared_video_warning_count = 0_usize;
        if ticket.blank_reason.is_none() {
            for (video_index, video) in ticket.deliverable_videos.clone().iter().enumerate() {
                if cancellation.is_cancelled() {
                    return Ok(cancelled_summary(
                        total_tickets,
                        host_warning_count,
                        started.elapsed(),
                    ));
                }
                match prepare_video(
                    &media_tools,
                    video,
                    staging.path(),
                    ticket_index,
                    video_index,
                ) {
                    Ok(prepared) => {
                        for warning in &prepared.warnings {
                            host_warning_count += 1;
                            forwarded_host_warnings += 1;
                            prepared_video_warning_count += 1;
                            emit_log(
                                events,
                                run_id,
                                Some(&ticket.name),
                                LogLevel::Warning,
                                warning.clone(),
                                Some(&video.path),
                            );
                        }
                        prepared_videos.push(prepared.manifest);
                    }
                    Err(error) => {
                        host_warning_count += 1;
                        // Prepared-video warnings are carried by their manifest assets.
                        // Blanking the ticket removes those assets, so those warnings become
                        // host-only and must not be treated as sidecar-counted warnings.
                        forwarded_host_warnings =
                            forwarded_host_warnings.saturating_sub(prepared_video_warning_count);
                        emit_log(
                            events,
                            run_id,
                            Some(&ticket.name),
                            LogLevel::Warning,
                            format!(
                                "Using a blank slide because {} could not be prepared: {error}",
                                video.path.display()
                            ),
                            Some(&video.path),
                        );
                        ticket.make_blank(format!(
                            "Selected video could not be prepared: {}",
                            video.path.file_name().unwrap_or_default().to_string_lossy()
                        ));
                        prepared_videos.clear();
                    }
                }
                progress.advance(PowerPointStep::Video);
                emit_progress(
                    events,
                    run_id,
                    PowerPointStep::Video,
                    Some(&ticket.name),
                    Some(ticket_index + 1),
                    total_tickets,
                    progress.video_completed,
                    video_total,
                    progress.completed_units,
                    total_units,
                    if ticket.blank_reason.is_some() {
                        "Rejected corrupt video and prepared a blank slide"
                    } else {
                        "Prepared video poster and playback metadata"
                    },
                );
                if ticket.blank_reason.is_some() {
                    for _ in (video_index + 1)..ticket.deliverable_videos.len() {
                        progress.advance(PowerPointStep::Video);
                        emit_progress(
                            events,
                            run_id,
                            PowerPointStep::Video,
                            Some(&ticket.name),
                            Some(ticket_index + 1),
                            total_tickets,
                            progress.video_completed,
                            video_total,
                            progress.completed_units,
                            total_units,
                            "Skipped video because this ticket will use a blank slide",
                        );
                    }
                    break;
                }
            }
        }

        let mut master = Vec::new();
        let mut deliverables = Vec::new();
        if ticket.blank_reason.is_none() {
            master.extend(ticket.master.iter().map(|image| ManifestAsset::Image {
                path: image.path.clone(),
                priority: image.priority,
            }));
            deliverables.extend(ticket.deliverable_images.iter().map(|image| {
                ManifestAsset::Image {
                    path: image.path.clone(),
                    priority: image.priority,
                }
            }));
            deliverables.extend(prepared_videos);
        }
        manifest_tickets.push(ManifestTicket {
            name: ticket.name,
            title: ticket.title,
            blank_reason: ticket.blank_reason,
            master,
            deliverables,
            warnings: ticket.warnings,
        });
    }

    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| AppError::new("powerPointTemplateUnavailable", error.to_string()))?;
    let template = resource_directory.join(TEMPLATE_RESOURCE);
    if !template.is_file() {
        return Err(AppError::new(
            "powerPointTemplateUnavailable",
            format!("PowerPoint template is missing: {}", template.display()),
        ));
    }
    let staged_output = staging.path().join(OUTPUT_NAME);
    let staged_report = staging.path().join(REPORT_NAME);
    let manifest_path = staging.path().join("manifest.json");
    let manifest = ManifestDocument {
        schema_version: 1,
        template,
        output: staged_output.clone(),
        report: staged_report.clone(),
        cancel_path,
        tickets: manifest_tickets,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| AppError::new("powerPointManifestFailed", error.to_string()))?;
    fs::write(&manifest_path, manifest_bytes)
        .map_err(|error| AppError::new("powerPointManifestFailed", error.to_string()))?;

    let sidecar_summary = run_sidecar(
        &app,
        &manifest_path,
        run_id,
        RunTotals {
            tickets: total_tickets,
            units: total_units,
            videos: video_total,
        },
        &mut progress,
        events,
    )?;
    if cancellation.is_cancelled() {
        return Ok(cancelled_summary(
            total_tickets,
            host_warning_count,
            started.elapsed(),
        ));
    }
    if sidecar_summary.slides_created != total_tickets
        || sidecar_summary.blank_slides > sidecar_summary.slides_created
    {
        return Err(AppError::new(
            "powerPointSidecarProtocolFailed",
            format!(
                "PowerPoint sidecar reported {} slide(s) and {} blank slide(s) for {total_tickets} ticket(s).",
                sidecar_summary.slides_created, sidecar_summary.blank_slides
            ),
        ));
    }

    validate_generated_file(&staged_output, "generated PowerPoint")?;
    validate_generated_file(&staged_report, "layout report")?;
    if cancellation.is_cancelled() {
        return Ok(cancelled_summary(
            total_tickets,
            host_warning_count,
            started.elapsed(),
        ));
    }
    let final_output = plan.output.join(OUTPUT_NAME);
    let final_report = plan.output.join(REPORT_NAME);
    if !state.begin_commit(run_id) {
        return Ok(cancelled_summary(
            total_tickets,
            host_warning_count,
            started.elapsed(),
        ));
    }
    publish_pair(&staged_output, &final_output, &staged_report, &final_report)
        .map_err(|error| AppError::new("publishPowerPointFailed", error.to_string()))?;

    while progress.save_completed < 2 {
        progress.advance(PowerPointStep::Save);
        emit_progress(
            events,
            run_id,
            PowerPointStep::Save,
            None,
            None,
            total_tickets,
            progress.save_completed,
            2,
            progress.completed_units,
            total_units,
            if progress.save_completed == 1 {
                "Saved presentation"
            } else {
                "Saved layout report"
            },
        );
    }

    let warning_count = merge_warning_counts(
        sidecar_summary.warnings,
        host_warning_count,
        forwarded_host_warnings,
    );
    let blank_slides = sidecar_summary.blank_slides;
    let summary = PowerPointSummary {
        status: if blank_slides > 0 {
            PowerPointRunStatus::PartialSuccess
        } else {
            PowerPointRunStatus::Success
        },
        total_tickets,
        slides_created: sidecar_summary.slides_created,
        blank_slides,
        warnings: warning_count,
        errors: 0,
        elapsed_ms: duration_ms(started.elapsed()),
        output_path: Some(final_output.to_string_lossy().into_owned()),
        report_path: Some(final_report.to_string_lossy().into_owned()),
    };
    state.set_last_output(final_output);
    Ok(summary)
}

fn prepare_video(
    runner: &impl MediaToolRunner,
    video: &SelectedVideo,
    staging: &Path,
    ticket_index: usize,
    video_index: usize,
) -> Result<PreparedVideo, String> {
    let arguments = vec![
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-print_format"),
        OsString::from("json"),
        OsString::from("-show_streams"),
        OsString::from("-show_format"),
        video.path.as_os_str().to_os_string(),
    ];
    let output = runner
        .run(NativeTool::Ffprobe, &arguments)
        .map_err(|error| error.to_string())?;
    ensure_tool_success(NativeTool::Ffprobe, &output)?;
    let probe: ProbeDocument = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid ffprobe JSON: {error}"))?;
    let video_stream = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| "no video stream found".to_owned())?;
    let width = video_stream
        .width
        .filter(|value| *value > 0)
        .ok_or_else(|| "video stream does not report a positive width".to_owned())?;
    let height = video_stream
        .height
        .filter(|value| *value > 0)
        .ok_or_else(|| "video stream does not report a positive height".to_owned())?;
    let duration = probe
        .format
        .duration
        .as_ref()
        .and_then(NumberOrString::value)
        .or_else(|| {
            video_stream
                .duration
                .as_ref()
                .and_then(NumberOrString::value)
        })
        .filter(|duration| *duration > 0.0)
        .ok_or_else(|| "video does not report a positive finite duration".to_owned())?;
    let extension = video
        .path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let formats = probe
        .format
        .format_name
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .collect::<Vec<_>>();
    let container_matches = match extension.as_str() {
        "mp4" => formats.contains(&"mp4") || formats.contains(&"mov"),
        "avi" => formats.contains(&"avi"),
        _ => false,
    };
    if !container_matches {
        return Err(format!(
            "decoded container {:?} does not match .{extension}",
            probe.format.format_name
        ));
    }

    let audio_streams = probe
        .streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some("audio"))
        .collect::<Vec<_>>();
    let portable = extension == "mp4"
        && video_stream.codec_name.as_deref() == Some("h264")
        && audio_streams
            .iter()
            .all(|stream| stream.codec_name.as_deref() == Some("aac"));
    let compatibility = if portable {
        "portable"
    } else {
        "platformDependent"
    };
    let mut warnings = Vec::new();
    if !portable {
        warnings.push(format!(
            "Embedded {} unchanged; playback depends on codecs available in PowerPoint.",
            video.path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }

    let poster_path = staging.join(format!("poster-{ticket_index}-{video_index}.jpg"));
    let poster_arguments = vec![
        OsString::from("-y"),
        OsString::from("-nostdin"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        video.path.as_os_str().to_os_string(),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-an"),
        OsString::from("-c:v"),
        OsString::from("mjpeg"),
        poster_path.as_os_str().to_os_string(),
    ];
    let poster = runner
        .run(NativeTool::Ffmpeg, &poster_arguments)
        .map_err(|error| error.to_string())?;
    ensure_tool_success(NativeTool::Ffmpeg, &poster)
        .map_err(|error| format!("poster extraction failed: {error}"))?;

    Ok(PreparedVideo {
        manifest: ManifestAsset::Video {
            path: video.path.clone(),
            poster_path,
            priority: video.priority,
            width_px: width,
            height_px: height,
            duration_ms: (duration * 1000.0).round() as u64,
            extension,
            compatibility: compatibility.to_owned(),
            sha256: sha256_file(&video.path).map_err(|error| error.to_string())?,
            warnings: warnings.clone(),
        },
        warnings,
    })
}

fn run_sidecar(
    app: &AppHandle,
    manifest: &Path,
    run_id: &str,
    totals: RunTotals,
    progress: &mut ProgressState,
    events: &impl PowerPointEventSink,
) -> Result<SidecarSummary, AppError> {
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| AppError::new("powerPointSidecarUnavailable", error.to_string()))?
        .env("LC_ALL", "C")
        .args([OsStr::new("build-manifest"), manifest.as_os_str()]);
    let mut command: ProcessCommand = command.into();
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| AppError::new("powerPointSidecarStartFailed", error.to_string()))?;
    let Some(stdout) = child.stdout.take() else {
        kill_and_reap(&mut child);
        return Err(AppError::new(
            "powerPointSidecarStartFailed",
            "stdout is unavailable",
        ));
    };
    let Some(stderr) = child.stderr.take() else {
        kill_and_reap(&mut child);
        return Err(AppError::new(
            "powerPointSidecarStartFailed",
            "stderr is unavailable",
        ));
    };
    let stderr_reader = thread::spawn(move || bounded_read(stderr, MAX_DIAGNOSTIC_BYTES));
    let protocol_result = (|| -> Result<Option<SidecarSummary>, AppError> {
        let mut completed_summary = None;
        for line in BufReader::new(stdout).lines() {
            let line = line.map_err(|error| {
                AppError::new("powerPointSidecarProtocolFailed", error.to_string())
            })?;
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&line).map_err(|error| {
                AppError::new(
                    "powerPointSidecarProtocolFailed",
                    format!("Invalid JSON line: {error}"),
                )
            })?;
            if value.get("protocol").and_then(Value::as_u64) != Some(1) {
                return Err(AppError::new(
                    "powerPointSidecarProtocolFailed",
                    "Sidecar event uses an unsupported protocol version.",
                ));
            }
            let event_type = value
                .get("event")
                .or_else(|| value.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            match event_type {
                "progress" => {
                    let step = match value.get("step").and_then(Value::as_str) {
                        Some("layout") => PowerPointStep::Layout,
                        Some("compose") => PowerPointStep::Compose,
                        Some("save") => PowerPointStep::Save,
                        _ => continue,
                    };
                    let ticket = value
                        .get("ticket")
                        .and_then(Value::as_str)
                        .filter(|ticket| !ticket.is_empty());
                    let index = value
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize);
                    let message = value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Generating presentation");
                    if step != PowerPointStep::Save || progress.save_completed < 2 {
                        progress.advance(step);
                    }
                    let step_total = match step {
                        PowerPointStep::Layout | PowerPointStep::Compose => totals.tickets,
                        PowerPointStep::Save => 2,
                        PowerPointStep::Inspect => totals.tickets,
                        PowerPointStep::Video => totals.videos,
                    };
                    emit_progress(
                        events,
                        run_id,
                        step,
                        ticket,
                        index,
                        totals.tickets,
                        progress.completed_for(step),
                        step_total,
                        progress.completed_units.min(totals.units),
                        totals.units,
                        message,
                    );
                }
                "log" => {
                    let level = match value.get("level").and_then(Value::as_str) {
                        Some("success") => LogLevel::Success,
                        Some("warning") => LogLevel::Warning,
                        Some("error") => LogLevel::Error,
                        _ => LogLevel::Info,
                    };
                    emit_log(
                        events,
                        run_id,
                        value.get("ticket").and_then(Value::as_str),
                        level,
                        value
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("PowerPoint sidecar update")
                            .to_owned(),
                        value.get("path").and_then(Value::as_str).map(Path::new),
                    );
                }
                "completed" => {
                    completed_summary = Some(
                        serde_json::from_value(
                            value.get("summary").cloned().unwrap_or(Value::Null),
                        )
                        .map_err(|error| {
                            AppError::new("powerPointSidecarProtocolFailed", error.to_string())
                        })?,
                    );
                }
                "cancelled" => {}
                _ => {
                    return Err(AppError::new(
                        "powerPointSidecarProtocolFailed",
                        format!("Unknown sidecar event: {event_type}"),
                    ));
                }
            }
        }
        Ok(completed_summary)
    })();
    let completed_summary = match protocol_result {
        Ok(summary) => summary,
        Err(error) => {
            kill_and_reap(&mut child);
            let _ = stderr_reader.join();
            return Err(error);
        }
    };

    let status_result = child.wait();
    let stderr = stderr_reader.join().unwrap_or_default();
    let status = status_result
        .map_err(|error| AppError::new("powerPointSidecarFailed", error.to_string()))?;
    if status.code() == Some(CANCELLED_EXIT_CODE) {
        return Ok(completed_summary.unwrap_or_default());
    }
    if !status.success() {
        return Err(AppError::new(
            "powerPointSidecarFailed",
            format!(
                "PowerPoint sidecar exited with status {:?}: {}",
                status.code(),
                if stderr.trim().is_empty() {
                    "no diagnostic output"
                } else {
                    stderr.trim()
                }
            ),
        ));
    }
    completed_summary.ok_or_else(|| {
        AppError::new(
            "powerPointSidecarProtocolFailed",
            "PowerPoint sidecar exited successfully without a completed event.",
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    events: &impl PowerPointEventSink,
    run_id: &str,
    step: PowerPointStep,
    ticket: Option<&str>,
    index: Option<usize>,
    total_tickets: usize,
    step_completed: usize,
    step_total: usize,
    completed_units: usize,
    total_units: usize,
    message: &str,
) {
    events.emit(PowerPointEvent::PowerpointProgress {
        run_id: run_id.to_owned(),
        step,
        ticket: ticket.map(str::to_owned),
        index,
        total_tickets,
        step_completed,
        step_total,
        completed_units,
        total_units,
        message: message.to_owned(),
    });
}

fn emit_log(
    events: &impl PowerPointEventSink,
    run_id: &str,
    ticket: Option<&str>,
    level: LogLevel,
    message: String,
    path: Option<&Path>,
) {
    events.emit(PowerPointEvent::Log {
        run_id: run_id.to_owned(),
        ticket: ticket.map(str::to_owned),
        level,
        message,
        path: path.map(|path| path.to_string_lossy().into_owned()),
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    });
}

fn cancelled_summary(
    total_tickets: usize,
    warnings: usize,
    elapsed: Duration,
) -> PowerPointSummary {
    PowerPointSummary {
        status: PowerPointRunStatus::Cancelled,
        total_tickets,
        slides_created: 0,
        blank_slides: 0,
        warnings,
        errors: 0,
        elapsed_ms: duration_ms(elapsed),
        output_path: None,
        report_path: None,
    }
}

fn merge_warning_counts(
    sidecar_warnings: usize,
    host_warnings: usize,
    forwarded_host_warnings: usize,
) -> usize {
    // The sidecar reports warnings forwarded in ticket/asset manifests together
    // with warnings it discovers itself. Add only host warnings that were not
    // represented in the manifest so shared warnings are counted exactly once.
    sidecar_warnings.saturating_add(host_warnings.saturating_sub(forwarded_host_warnings))
}

fn ensure_tool_success(tool: NativeTool, output: &ToolOutput) -> Result<(), String> {
    if output.success {
        return Ok(());
    }
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    let diagnostic = diagnostic.trim();
    Err(format!(
        "{tool} exited with status {:?}: {}",
        output.code,
        if diagnostic.is_empty() {
            "no diagnostic output"
        } else {
            diagnostic
        }
    ))
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn bounded_read(mut reader: impl Read, limit: usize) -> String {
    let mut bytes = Vec::new();
    let _ = reader.by_ref().take(limit as u64).read_to_end(&mut bytes);
    let mut value = String::from_utf8_lossy(&bytes).into_owned();
    if bytes.len() == limit {
        value.push('…');
    }
    value
}

fn kill_and_reap(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn validate_generated_file(path: &Path, label: &str) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        AppError::new(
            "powerPointOutputInvalid",
            format!("Cannot inspect {label}: {error}"),
        )
    })?;
    if metadata_is_link_like(&metadata) || !metadata.is_file() || metadata.len() == 0 {
        return Err(AppError::new(
            "powerPointOutputInvalid",
            format!("The {label} is not a non-empty regular file."),
        ));
    }
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| AppError::new("powerPointOutputInvalid", error.to_string()))
}

fn publish_pair(
    staged_first: &Path,
    destination_first: &Path,
    staged_second: &Path,
    destination_second: &Path,
) -> io::Result<()> {
    publish_pair_with_operations(
        staged_first,
        destination_first,
        staged_second,
        destination_second,
        &StandardPublishOperations,
    )
}

trait PublishOperations {
    fn rename(&self, source: &Path, destination: &Path) -> io::Result<()>;
    fn remove_file(&self, path: &Path) -> io::Result<()>;
}

struct StandardPublishOperations;

impl PublishOperations for StandardPublishOperations {
    fn rename(&self, source: &Path, destination: &Path) -> io::Result<()> {
        fs::rename(source, destination)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

fn publish_pair_with_operations(
    staged_first: &Path,
    destination_first: &Path,
    staged_second: &Path,
    destination_second: &Path,
    operations: &impl PublishOperations,
) -> io::Result<()> {
    validate_destination(destination_first)?;
    validate_destination(destination_second)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let backup_first = destination_first.with_extension(format!("pptx.backup-{nonce}"));
    let backup_second = destination_second.with_extension(format!("json.backup-{nonce}"));
    let first_existed = destination_first.exists();
    let second_existed = destination_second.exists();
    let mut first_backed_up = false;
    let mut second_backed_up = false;
    let mut first_installed = false;
    let mut second_installed = false;

    let result = (|| -> io::Result<()> {
        if first_existed {
            operations.rename(destination_first, &backup_first)?;
            first_backed_up = true;
        }
        if second_existed {
            operations.rename(destination_second, &backup_second)?;
            second_backed_up = true;
        }
        operations.rename(staged_first, destination_first)?;
        first_installed = true;
        operations.rename(staged_second, destination_second)?;
        second_installed = true;
        Ok(())
    })();

    if let Err(error) = result {
        if second_installed {
            let _ = operations.remove_file(destination_second);
        }
        if first_installed {
            let _ = operations.remove_file(destination_first);
        }
        if second_backed_up {
            let _ = operations.rename(&backup_second, destination_second);
        }
        if first_backed_up {
            let _ = operations.rename(&backup_first, destination_first);
        }
        return Err(error);
    }
    if first_backed_up {
        operations.remove_file(&backup_first)?;
    }
    if second_backed_up {
        operations.remove_file(&backup_second)?;
    }
    Ok(())
}

fn validate_destination(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata_is_link_like(&metadata) || !metadata.is_file() => {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("refusing to replace unsafe output: {}", path.display()),
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::Mutex;

    use tempfile::tempdir;

    use super::*;

    struct PosterTools {
        probe: Vec<u8>,
        poster_succeeds: bool,
        calls: Mutex<Vec<(NativeTool, Vec<OsString>)>>,
    }

    impl MediaToolRunner for PosterTools {
        fn run(
            &self,
            tool: NativeTool,
            arguments: &[OsString],
        ) -> Result<ToolOutput, crate::pipeline::videos::ToolRunError> {
            self.calls.lock().unwrap().push((tool, arguments.to_vec()));
            if tool == NativeTool::Ffmpeg {
                if self.poster_succeeds {
                    fs::write(PathBuf::from(arguments.last().unwrap()), b"poster").unwrap();
                }
                return Ok(ToolOutput {
                    success: self.poster_succeeds,
                    code: Some(if self.poster_succeeds { 0 } else { 1 }),
                    stdout: Vec::new(),
                    stderr: if self.poster_succeeds {
                        Vec::new()
                    } else {
                        b"cannot decode first frame".to_vec()
                    },
                });
            }
            Ok(ToolOutput {
                success: true,
                code: Some(0),
                stdout: self.probe.clone(),
                stderr: Vec::new(),
            })
        }
    }

    struct FailingRenameOperations {
        fail_on_rename: usize,
        rename_count: Cell<usize>,
    }

    impl PublishOperations for FailingRenameOperations {
        fn rename(&self, source: &Path, destination: &Path) -> io::Result<()> {
            let call = self.rename_count.get() + 1;
            self.rename_count.set(call);
            if call == self.fail_on_rename {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected rename failure",
                ));
            }
            fs::rename(source, destination)
        }

        fn remove_file(&self, path: &Path) -> io::Result<()> {
            fs::remove_file(path)
        }
    }

    #[test]
    fn pair_publication_replaces_both_files() {
        let temp = tempdir().unwrap();
        let staged_deck = temp.path().join("new.pptx");
        let staged_report = temp.path().join("new.json");
        let deck = temp.path().join(OUTPUT_NAME);
        let report = temp.path().join(REPORT_NAME);
        fs::write(&staged_deck, b"new deck").unwrap();
        fs::write(&staged_report, b"new report").unwrap();
        fs::write(&deck, b"old deck").unwrap();
        fs::write(&report, b"old report").unwrap();

        publish_pair(&staged_deck, &deck, &staged_report, &report).unwrap();

        assert_eq!(fs::read(deck).unwrap(), b"new deck");
        assert_eq!(fs::read(report).unwrap(), b"new report");
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("backup")));
    }

    #[test]
    fn backup_failure_never_removes_an_untouched_output() {
        let temp = tempdir().unwrap();
        let staged_deck = temp.path().join("new.pptx");
        let staged_report = temp.path().join("new.json");
        let deck = temp.path().join(OUTPUT_NAME);
        let report = temp.path().join(REPORT_NAME);
        fs::write(&staged_deck, b"new deck").unwrap();
        fs::write(&staged_report, b"new report").unwrap();
        fs::write(&deck, b"old deck").unwrap();
        fs::write(&report, b"old report").unwrap();
        let operations = FailingRenameOperations {
            fail_on_rename: 2,
            rename_count: Cell::new(0),
        };

        assert!(publish_pair_with_operations(
            &staged_deck,
            &deck,
            &staged_report,
            &report,
            &operations,
        )
        .is_err());

        assert_eq!(fs::read(&deck).unwrap(), b"old deck");
        assert_eq!(fs::read(&report).unwrap(), b"old report");
        assert_eq!(fs::read(&staged_deck).unwrap(), b"new deck");
        assert_eq!(fs::read(&staged_report).unwrap(), b"new report");
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("backup")));
    }

    #[test]
    fn unsafe_destination_is_preserved() {
        let temp = tempdir().unwrap();
        let staged_deck = temp.path().join("new.pptx");
        let staged_report = temp.path().join("new.json");
        let deck = temp.path().join(OUTPUT_NAME);
        let report = temp.path().join(REPORT_NAME);
        fs::write(&staged_deck, b"new deck").unwrap();
        fs::write(&staged_report, b"new report").unwrap();
        fs::create_dir(&deck).unwrap();

        assert!(publish_pair(&staged_deck, &deck, &staged_report, &report).is_err());
        assert!(deck.is_dir());
    }

    #[test]
    fn video_preparation_probes_and_extracts_a_poster_without_transcoding_source() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("clip.mp4");
        let source_bytes = b"unchanged source video bytes";
        fs::write(&source, source_bytes).unwrap();
        let tools = PosterTools {
            probe: br#"{
                "streams":[
                    {"codec_type":"video","codec_name":"h264","width":1920,"height":1080},
                    {"codec_type":"audio","codec_name":"aac"}
                ],
                "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"2.5"}
            }"#
            .to_vec(),
            poster_succeeds: true,
            calls: Mutex::new(Vec::new()),
        };

        let prepared = prepare_video(
            &tools,
            &SelectedVideo {
                path: source.clone(),
                priority: 4,
            },
            temp.path(),
            0,
            0,
        )
        .unwrap();

        assert_eq!(fs::read(&source).unwrap(), source_bytes);
        assert!(prepared.warnings.is_empty());
        match prepared.manifest {
            ManifestAsset::Video {
                path,
                poster_path,
                compatibility,
                duration_ms,
                ..
            } => {
                assert_eq!(path, source);
                assert_eq!(compatibility, "portable");
                assert_eq!(duration_ms, 2_500);
                assert_eq!(fs::read(poster_path).unwrap(), b"poster");
            }
            ManifestAsset::Image { .. } => panic!("expected a video manifest asset"),
        }
        let calls = tools.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, NativeTool::Ffprobe);
        assert_eq!(calls[1].0, NativeTool::Ffmpeg);
        assert!(calls[1]
            .1
            .windows(2)
            .any(|pair| pair == [OsString::from("-frames:v"), OsString::from("1")]));
    }

    #[test]
    fn video_with_an_undecodable_poster_is_rejected_as_corrupt() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("clip.mp4");
        fs::write(&source, b"video bytes").unwrap();
        let tools = PosterTools {
            probe: br#"{
                "streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360}],
                "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"1"}
            }"#
            .to_vec(),
            poster_succeeds: false,
            calls: Mutex::new(Vec::new()),
        };

        let error = prepare_video(
            &tools,
            &SelectedVideo {
                path: source,
                priority: 3,
            },
            temp.path(),
            0,
            0,
        )
        .unwrap_err();

        assert!(error.contains("poster extraction failed"));
        assert!(error.contains("cannot decode first frame"));
    }

    #[test]
    fn warning_merge_counts_forwarded_host_warnings_once() {
        assert_eq!(merge_warning_counts(4, 3, 2), 5);
        assert_eq!(merge_warning_counts(4, 2, 2), 4);
        assert_eq!(merge_warning_counts(1, 4, 0), 5);
    }
}
