use std::path::PathBuf;
use tauri::Manager;

/// Resolve the path to the board file inside the app data directory,
/// creating the directory if it does not exist yet.
fn board_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create app data dir: {}", e))?;
    Ok(dir.join("board.json"))
}

/// Load the saved board JSON. Returns an empty string when no board has been
/// saved yet so the frontend can fall back to its default starter board.
#[tauri::command]
fn load_board(app: tauri::AppHandle) -> Result<String, String> {
    let path = board_path(&app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("cannot read board: {}", e))
}

/// Persist the board JSON to the app data directory.
#[tauri::command]
fn save_board(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let path = board_path(&app)?;
    std::fs::write(&path, data).map_err(|e| format!("cannot save board: {}", e))
}

/// Write the board JSON to a user-chosen path (used by Export).
#[tauri::command]
fn export_board(path: String, data: String) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("cannot export board: {}", e))
}

/// Read board JSON from a user-chosen path (used by Import).
#[tauri::command]
fn import_board(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("cannot import board: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_board,
            save_board,
            export_board,
            import_board
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
