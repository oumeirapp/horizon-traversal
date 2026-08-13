mod commands;
#[cfg(feature = "packaged-smoke")]
mod packaged_smoke;
pub mod pipeline;
mod settings;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state::AppState::default())
        .manage(settings::SettingsState::default())
        .invoke_handler(tauri::generate_handler![
            commands::load_settings,
            commands::save_settings,
            commands::validate_selection,
            commands::start_pipeline,
            commands::open_last_output
        ]);

    #[cfg(feature = "packaged-smoke")]
    let builder = builder.setup(packaged_smoke::setup);

    builder
        .run(tauri::generate_context!())
        .expect("error while running Horizon Traversal");
}
