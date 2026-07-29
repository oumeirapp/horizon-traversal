mod commands;
pub mod pipeline;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::validate_selection,
            commands::start_pipeline,
            commands::open_last_output
        ])
        .run(tauri::generate_context!())
        .expect("error while running X Traversal");
}
