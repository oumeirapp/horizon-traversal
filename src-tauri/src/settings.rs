use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use thiserror::Error;

use crate::pipeline::files::{create_temporary_file, remove_if_exists, replace_file};

const SETTINGS_FILE_NAME: &str = "settings.json";
const SETTINGS_SCHEMA_VERSION: u32 = 1;
const DEFAULT_OUTPUT_ROOT_NAME: &str = "horizon-traversal";
const LEGACY_DEFAULT_OUTPUT_ROOT_NAME: &str = "Horizon Traversal";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    #[default]
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub default_output_path: String,
    pub powerpoint_output_path: String,
    pub theme: Theme,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsDocument {
    schema_version: u32,
    settings: AppSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSettingsDocument {
    schema_version: u32,
    settings: StoredAppSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAppSettings {
    default_output_path: String,
    #[serde(default)]
    powerpoint_output_path: Option<String>,
    theme: Theme,
}

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("Cannot resolve the output folders: {0}")]
    DefaultsUnavailable(String),
    #[error("Cannot resolve the settings file location: {0}")]
    PathUnavailable(String),
    #[error("Cannot read settings from {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("The settings file is not valid: {0}")]
    Invalid(String),
    #[error("Settings schema version {0} is not supported by this version of the app.")]
    UnsupportedVersion(u32),
    #[error("Cannot save settings to {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Cannot serialize settings: {0}")]
    Serialize(#[from] serde_json::Error),
}

impl SettingsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DefaultsUnavailable(_) => "settingsDefaultsUnavailable",
            Self::PathUnavailable(_) => "settingsPathUnavailable",
            Self::Read { .. } => "settingsReadFailed",
            Self::Invalid(_) => "settingsInvalid",
            Self::UnsupportedVersion(_) => "settingsVersionUnsupported",
            Self::Write { .. } | Self::Serialize(_) => "settingsWriteFailed",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SettingsState {
    io_lock: Arc<Mutex<()>>,
}

impl SettingsState {
    pub fn load(
        &self,
        settings_path: &Path,
        defaults: AppSettings,
    ) -> Result<AppSettings, SettingsError> {
        let _guard = self
            .io_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        load_from_path(settings_path, defaults)
    }

    pub fn save(
        &self,
        settings_path: &Path,
        settings: AppSettings,
    ) -> Result<AppSettings, SettingsError> {
        let settings = validate_settings(settings)?;
        let _guard = self
            .io_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        save_to_path(settings_path, &settings)?;
        Ok(settings)
    }
}

pub fn default_settings(app: &AppHandle) -> Result<AppSettings, SettingsError> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| SettingsError::DefaultsUnavailable(error.to_string()))?;
    default_settings_for(&downloads)
}

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, SettingsError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SETTINGS_FILE_NAME))
        .map_err(|error| SettingsError::PathUnavailable(error.to_string()))
}

fn default_settings_for(downloads: &Path) -> Result<AppSettings, SettingsError> {
    let product_directory = downloads.join(DEFAULT_OUTPUT_ROOT_NAME);
    let default_output_path = product_directory.join("output");
    let default_output_path = default_output_path.to_str().ok_or_else(|| {
        SettingsError::DefaultsUnavailable("the Downloads path is not valid UTF-8".to_owned())
    })?;
    let powerpoint_output_path = product_directory.join("pptx");
    let powerpoint_output_path = powerpoint_output_path.to_str().ok_or_else(|| {
        SettingsError::DefaultsUnavailable("the Downloads path is not valid UTF-8".to_owned())
    })?;

    Ok(AppSettings {
        default_output_path: default_output_path.to_owned(),
        powerpoint_output_path: powerpoint_output_path.to_owned(),
        theme: Theme::default(),
    })
}

fn validate_settings(mut settings: AppSettings) -> Result<AppSettings, SettingsError> {
    settings.default_output_path =
        validate_output_path("defaultOutputPath", &settings.default_output_path)?;
    settings.powerpoint_output_path =
        validate_output_path("powerpointOutputPath", &settings.powerpoint_output_path)?;
    Ok(settings)
}

fn validate_output_path(field_name: &str, output_path: &str) -> Result<String, SettingsError> {
    let output_path = output_path.trim();
    if output_path.is_empty() {
        return Err(SettingsError::Invalid(format!(
            "{field_name} must not be empty"
        )));
    }
    if !Path::new(output_path).is_absolute() {
        return Err(SettingsError::Invalid(format!(
            "{field_name} must be an absolute path"
        )));
    }

    Ok(output_path.to_owned())
}

fn load_from_path(
    settings_path: &Path,
    defaults: AppSettings,
) -> Result<AppSettings, SettingsError> {
    let bytes = match fs::read(settings_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(defaults),
        Err(source) => {
            return Err(SettingsError::Read {
                path: settings_path.to_path_buf(),
                source,
            });
        }
    };
    let document: StoredSettingsDocument = serde_json::from_slice(&bytes)
        .map_err(|error| SettingsError::Invalid(error.to_string()))?;
    if document.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err(SettingsError::UnsupportedVersion(document.schema_version));
    }
    let legacy_document = document.settings.powerpoint_output_path.is_none();
    let default_output_path = if legacy_document {
        migrate_legacy_default_output_path(document.settings.default_output_path, &defaults)
    } else {
        document.settings.default_output_path
    };
    validate_settings(AppSettings {
        default_output_path,
        powerpoint_output_path: document
            .settings
            .powerpoint_output_path
            .unwrap_or(defaults.powerpoint_output_path),
        theme: document.settings.theme,
    })
}

fn migrate_legacy_default_output_path(
    stored_output_path: String,
    defaults: &AppSettings,
) -> String {
    let Some(downloads) = Path::new(&defaults.default_output_path)
        .parent()
        .and_then(Path::parent)
    else {
        return stored_output_path;
    };
    if Path::new(&stored_output_path) == downloads.join(LEGACY_DEFAULT_OUTPUT_ROOT_NAME) {
        defaults.default_output_path.clone()
    } else {
        stored_output_path
    }
}

fn save_to_path(settings_path: &Path, settings: &AppSettings) -> Result<(), SettingsError> {
    let parent = settings_path.parent().ok_or_else(|| {
        SettingsError::PathUnavailable("the settings path has no parent directory".to_owned())
    })?;
    fs::create_dir_all(parent).map_err(|source| SettingsError::Write {
        path: settings_path.to_path_buf(),
        source,
    })?;

    let document = SettingsDocument {
        schema_version: SETTINGS_SCHEMA_VERSION,
        settings: settings.clone(),
    };
    let mut bytes = serde_json::to_vec_pretty(&document)?;
    bytes.push(b'\n');

    let (temporary_path, mut temporary_file) =
        create_temporary_file(settings_path).map_err(|source| SettingsError::Write {
            path: settings_path.to_path_buf(),
            source,
        })?;
    let write_result = (|| -> io::Result<()> {
        temporary_file.write_all(&bytes)?;
        temporary_file.flush()?;
        temporary_file.sync_all()
    })();
    drop(temporary_file);

    if let Err(source) = write_result {
        remove_if_exists(&temporary_path);
        return Err(SettingsError::Write {
            path: settings_path.to_path_buf(),
            source,
        });
    }
    if let Err(source) = replace_file(&temporary_path, settings_path) {
        remove_if_exists(&temporary_path);
        return Err(SettingsError::Write {
            path: settings_path.to_path_buf(),
            source,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    fn settings(default_output_path: &Path, theme: Theme) -> AppSettings {
        AppSettings {
            default_output_path: default_output_path.to_string_lossy().into_owned(),
            powerpoint_output_path: default_output_path
                .join("pptx")
                .to_string_lossy()
                .into_owned(),
            theme,
        }
    }

    #[test]
    fn defaults_use_distinct_horizon_traversal_folders_and_preserve_the_dark_theme() {
        let temporary = tempdir().unwrap();
        let downloads = temporary.path().join("Downloads");

        let defaults = default_settings_for(&downloads).unwrap();

        assert_eq!(
            PathBuf::from(defaults.default_output_path),
            downloads.join("horizon-traversal/output")
        );
        assert_eq!(
            PathBuf::from(defaults.powerpoint_output_path),
            downloads.join("horizon-traversal/pptx")
        );
        assert_eq!(defaults.theme, Theme::Dark);
    }

    #[test]
    fn a_missing_file_returns_defaults_without_creating_any_files() {
        let temporary = tempdir().unwrap();
        let settings_path = temporary.path().join("config/settings.json");
        let defaults = settings(
            &temporary.path().join("Downloads/Horizon Traversal"),
            Theme::Dark,
        );

        let loaded = SettingsState::default()
            .load(&settings_path, defaults.clone())
            .unwrap();

        assert_eq!(loaded, defaults);
        assert!(!settings_path.exists());
        assert!(!settings_path.parent().unwrap().exists());
    }

    #[test]
    fn save_writes_the_versioned_camel_case_document_and_load_round_trips_it() {
        let temporary = tempdir().unwrap();
        let settings_path = temporary.path().join("config/settings.json");
        let state = SettingsState::default();
        let saved = settings(&temporary.path().join("exports"), Theme::Light);

        assert_eq!(state.save(&settings_path, saved.clone()).unwrap(), saved);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&settings_path).unwrap())
                .unwrap(),
            json!({
                "schemaVersion": 1,
                "settings": {
                    "defaultOutputPath": saved.default_output_path,
                    "powerpointOutputPath": saved.powerpoint_output_path,
                    "theme": "light"
                }
            })
        );
        assert_eq!(
            state
                .load(
                    &settings_path,
                    settings(&temporary.path().join("unused"), Theme::Dark)
                )
                .unwrap(),
            saved
        );
    }

    #[test]
    fn repeated_saves_replace_the_complete_document_without_leaving_temporary_files() {
        let temporary = tempdir().unwrap();
        let settings_path = temporary.path().join("settings.json");
        let state = SettingsState::default();

        state
            .save(
                &settings_path,
                settings(&temporary.path().join("first"), Theme::Dark),
            )
            .unwrap();
        let second = settings(&temporary.path().join("second"), Theme::Light);
        state.save(&settings_path, second.clone()).unwrap();

        assert_eq!(
            state
                .load(
                    &settings_path,
                    settings(&temporary.path().join("unused"), Theme::Dark)
                )
                .unwrap(),
            second
        );
        assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 1);
    }

    #[test]
    fn validation_rejects_empty_and_relative_paths_but_allows_missing_absolute_paths() {
        let temporary = tempdir().unwrap();
        let state = SettingsState::default();
        let settings_path = temporary.path().join("settings.json");

        for invalid in ["", "  ", "relative/output"] {
            let mut invalid_default = settings(&temporary.path().join("valid"), Theme::Dark);
            invalid_default.default_output_path = invalid.to_owned();
            let error = state.save(&settings_path, invalid_default).unwrap_err();
            assert_eq!(error.code(), "settingsInvalid");

            let mut invalid_powerpoint = settings(&temporary.path().join("valid"), Theme::Dark);
            invalid_powerpoint.powerpoint_output_path = invalid.to_owned();
            let error = state.save(&settings_path, invalid_powerpoint).unwrap_err();
            assert_eq!(error.code(), "settingsInvalid");
        }

        let missing = temporary.path().join("missing/output");
        let saved = state
            .save(&settings_path, settings(&missing, Theme::Dark))
            .unwrap();
        assert_eq!(PathBuf::from(saved.default_output_path), missing);
        assert!(!missing.exists());
    }

    #[test]
    fn an_existing_document_without_a_powerpoint_path_uses_the_native_default() {
        let temporary = tempdir().unwrap();
        let settings_path = temporary.path().join("settings.json");
        let downloads = temporary.path().join("Downloads");
        let defaults = default_settings_for(&downloads).unwrap();
        let legacy_output = temporary.path().join("legacy-output");
        let document = json!({
            "schemaVersion": 1,
            "settings": {
                "defaultOutputPath": legacy_output,
                "theme": "light"
            }
        })
        .to_string();
        fs::write(&settings_path, &document).unwrap();

        let loaded = SettingsState::default()
            .load(&settings_path, defaults.clone())
            .unwrap();

        assert_eq!(PathBuf::from(loaded.default_output_path), legacy_output);
        assert_eq!(
            loaded.powerpoint_output_path,
            defaults.powerpoint_output_path
        );
        assert_eq!(loaded.theme, Theme::Light);
        assert_eq!(fs::read_to_string(settings_path).unwrap(), document);
    }

    #[test]
    fn a_legacy_native_default_moves_to_the_new_asset_output_subfolder() {
        let temporary = tempdir().unwrap();
        let settings_path = temporary.path().join("settings.json");
        let downloads = temporary.path().join("Downloads");
        let defaults = default_settings_for(&downloads).unwrap();
        let document = json!({
            "schemaVersion": 1,
            "settings": {
                "defaultOutputPath": downloads.join(LEGACY_DEFAULT_OUTPUT_ROOT_NAME),
                "theme": "dark"
            }
        })
        .to_string();
        fs::write(&settings_path, &document).unwrap();

        let loaded = SettingsState::default()
            .load(&settings_path, defaults.clone())
            .unwrap();

        assert_eq!(loaded.default_output_path, defaults.default_output_path);
        assert_eq!(
            loaded.powerpoint_output_path,
            defaults.powerpoint_output_path
        );
        assert_eq!(fs::read_to_string(settings_path).unwrap(), document);
    }

    #[test]
    fn malformed_unknown_and_unsupported_documents_are_rejected_without_being_changed() {
        let temporary = tempdir().unwrap();
        let settings_path = temporary.path().join("settings.json");
        let defaults = settings(&temporary.path().join("default"), Theme::Dark);
        let state = SettingsState::default();

        for document in [
            "not json".to_owned(),
            json!({
                "schemaVersion": 1,
                "settings": {
                    "defaultOutputPath": defaults.default_output_path,
                    "theme": "system"
                }
            })
            .to_string(),
            json!({
                "schemaVersion": 1,
                "settings": {
                    "defaultOutputPath": defaults.default_output_path,
                    "theme": "dark",
                    "unknown": true
                }
            })
            .to_string(),
        ] {
            fs::write(&settings_path, &document).unwrap();
            let error = state.load(&settings_path, defaults.clone()).unwrap_err();
            assert_eq!(error.code(), "settingsInvalid");
            assert_eq!(fs::read_to_string(&settings_path).unwrap(), document);
        }

        let unsupported = json!({
            "schemaVersion": 2,
            "settings": {
                "defaultOutputPath": defaults.default_output_path,
                "theme": "dark"
            }
        })
        .to_string();
        fs::write(&settings_path, &unsupported).unwrap();
        let error = state.load(&settings_path, defaults).unwrap_err();
        assert_eq!(error.code(), "settingsVersionUnsupported");
        assert_eq!(fs::read_to_string(settings_path).unwrap(), unsupported);
    }

    #[test]
    fn a_valid_save_can_recover_a_malformed_settings_file() {
        let temporary = tempdir().unwrap();
        let settings_path = temporary.path().join("settings.json");
        fs::write(&settings_path, "truncated {").unwrap();
        let state = SettingsState::default();
        let recovered = settings(&temporary.path().join("recovered"), Theme::Light);

        state.save(&settings_path, recovered.clone()).unwrap();

        assert_eq!(
            state
                .load(
                    &settings_path,
                    settings(&temporary.path().join("unused"), Theme::Dark)
                )
                .unwrap(),
            recovered
        );
    }
}
