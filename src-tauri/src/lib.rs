use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// The sync code and the address this device is signed in as. Kept in a file
/// next to the board, not in the browser store, so clearing the app's cache
/// does not silently sign the device out. The PASSWORD is never kept.
#[derive(Serialize, Deserialize, Default)]
struct SyncConfig {
    /// Reaches this account's copy on the server. Empty when signed out. The
    /// user never sees it; signing in fetches it.
    #[serde(default)]
    code: String,
    /// Shown in Settings so people know who they are signed in as.
    #[serde(default)]
    email: String,
}

fn sync_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create app data dir: {}", e))?;
    Ok(dir.join("sync.json"))
}

fn read_sync_config(app: &tauri::AppHandle) -> SyncConfig {
    sync_config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_sync_config(app: &tauri::AppHandle, config: &SyncConfig) -> Result<(), String> {
    let path = sync_config_path(app)?;
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("cannot save sync settings: {}", e))
}

#[tauri::command]
fn sync_code(app: tauri::AppHandle) -> String {
    read_sync_config(&app).code
}

#[tauri::command]
fn set_sync_code(app: tauri::AppHandle, code: String) -> Result<(), String> {
    let mut config = read_sync_config(&app);
    config.code = code;
    write_sync_config(&app, &config)
}

#[tauri::command]
fn sync_email(app: tauri::AppHandle) -> String {
    read_sync_config(&app).email
}

#[tauri::command]
fn set_sync_email(app: tauri::AppHandle, email: String) -> Result<(), String> {
    let mut config = read_sync_config(&app);
    config.email = email;
    write_sync_config(&app, &config)
}

/// Keep a copy of the board as it stands, under a name that says when it was
/// parked. Used when another device's version wins, so nothing this device did
/// is ever thrown away.
#[tauri::command]
fn park_conflict(app: tauri::AppHandle, data: String) -> Result<String, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = board_path(&app)?.with_file_name(format!("board.conflict.{}.json", stamp));
    std::fs::write(&path, data).map_err(|e| format!("cannot keep a copy: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

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

/// Resolve (and create) the folder where pasted note images are kept.
fn images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {}", e))?
        .join("images");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create images dir: {}", e))?;
    Ok(dir)
}

/// Resolve (and create) the folder where attached PDFs are kept.
fn files_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {}", e))?
        .join("files");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create files dir: {}", e))?;
    Ok(dir)
}

/// Keep only the file-name component so a stored name can never escape the folder.
fn safe_name(file_name: &str) -> Result<String, String> {
    std::path::Path::new(file_name)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "invalid image name".to_string())
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

/// Save a pasted image (base64) to the images folder under the given file name.
#[tauri::command]
fn save_image(app: tauri::AppHandle, file_name: String, data_base64: String) -> Result<(), String> {
    let dir = images_dir(&app)?;
    let bytes = general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("cannot decode image: {}", e))?;
    std::fs::write(dir.join(safe_name(&file_name)?), bytes)
        .map_err(|e| format!("cannot save image: {}", e))
}

/// Read a stored image back as base64 for display.
#[tauri::command]
fn load_image(app: tauri::AppHandle, file_name: String) -> Result<String, String> {
    let dir = images_dir(&app)?;
    let bytes = std::fs::read(dir.join(safe_name(&file_name)?))
        .map_err(|e| format!("cannot read image: {}", e))?;
    Ok(general_purpose::STANDARD.encode(bytes))
}

/// Delete a stored image (best effort).
#[tauri::command]
fn delete_image(app: tauri::AppHandle, file_name: String) -> Result<(), String> {
    let dir = images_dir(&app)?;
    let path = dir.join(safe_name(&file_name)?);
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Copy a picked file into the app's own files folder, under the given name.
#[tauri::command]
fn attach_file(app: tauri::AppHandle, source: String, file_name: String) -> Result<u64, String> {
    let dir = files_dir(&app)?;
    let dest = dir.join(safe_name(&file_name)?);
    std::fs::copy(&source, &dest).map_err(|e| format!("cannot copy file: {}", e))
}

/// Write a pasted file (base64) into the app's files folder.
#[tauri::command]
fn put_file(app: tauri::AppHandle, file_name: String, data_base64: String) -> Result<(), String> {
    let dir = files_dir(&app)?;
    let bytes = general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("cannot decode file: {}", e))?;
    std::fs::write(dir.join(safe_name(&file_name)?), bytes)
        .map_err(|e| format!("cannot save file: {}", e))
}

/// Read a stored file back as base64, so its text can be pulled out.
#[tauri::command]
fn read_file(app: tauri::AppHandle, file_name: String) -> Result<String, String> {
    let dir = files_dir(&app)?;
    let bytes = std::fs::read(dir.join(safe_name(&file_name)?))
        .map_err(|e| format!("cannot read file: {}", e))?;
    Ok(general_purpose::STANDARD.encode(bytes))
}

/// Absolute path of a stored file, so it can be opened with the default app.
#[tauri::command]
fn file_path(app: tauri::AppHandle, file_name: String) -> Result<String, String> {
    let path = files_dir(&app)?.join(safe_name(&file_name)?);
    if !path.exists() {
        return Err("file not found".to_string());
    }
    Ok(path.to_string_lossy().to_string())
}

/// Delete a stored file (best effort).
#[tauri::command]
fn delete_file(app: tauri::AppHandle, file_name: String) -> Result<(), String> {
    let path = files_dir(&app)?.join(safe_name(&file_name)?);
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// What the app itself is costing the machine right now: share of the
/// processor since the last look, and share of the memory in use.
#[cfg(windows)]
fn read_usage() -> (String, String) {
    use std::sync::Mutex;
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::SystemInformation::{
        GetSystemInfo, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    static LAST: Mutex<Option<(u64, std::time::Instant)>> = Mutex::new(None);
    let hundred_ns =
        |time: FILETIME| ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;

    unsafe {
        let process = GetCurrentProcess();
        let (mut created, mut exited, mut kernel, mut user) = Default::default();
        let cpu = if GetProcessTimes(
            process,
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
        .is_ok()
        {
            let busy = hundred_ns(kernel) + hundred_ns(user);
            let now = std::time::Instant::now();
            let mut cores = SYSTEM_INFO::default();
            GetSystemInfo(&mut cores);
            let cores = cores.dwNumberOfProcessors.max(1) as f64;

            let mut last = LAST.lock().ok();
            let share = match last.as_ref().and_then(|slot| slot.as_ref()) {
                Some((was_busy, was_at)) => {
                    let elapsed = now.duration_since(*was_at).as_secs_f64();
                    if elapsed <= 0.0 {
                        0.0
                    } else {
                        let spent = busy.saturating_sub(*was_busy) as f64 / 10_000_000.0;
                        (spent / elapsed / cores * 100.0).clamp(0.0, 100.0)
                    }
                }
                None => 0.0,
            };
            if let Some(slot) = last.as_mut() {
                **slot = Some((busy, now));
            }
            format!("{:.1}%", share)
        } else {
            "n/a".to_string()
        };

        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let mut total = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        let ram = if GetProcessMemoryInfo(process, &mut counters, size).is_ok()
            && GlobalMemoryStatusEx(&mut total).is_ok()
            && total.ullTotalPhys > 0
        {
            format!(
                "{:.1}%",
                counters.WorkingSetSize as f64 / total.ullTotalPhys as f64 * 100.0
            )
        } else {
            "n/a".to_string()
        };

        (cpu, ram)
    }
}

/// CPU and memory this process is using, as ready-to-show strings.
#[tauri::command]
fn usage() -> (String, String) {
    #[cfg(windows)]
    {
        read_usage()
    }
    #[cfg(not(windows))]
    {
        ("n/a".to_string(), "n/a".to_string())
    }
}

/// What the user's own data takes up: the board, its images and its PDFs. The
/// webview's own cache folder is skipped, since Windows manages that, it dwarfs
/// everything else, and the user cannot do anything about it.
#[tauri::command]
fn cache_size(app: tauri::AppHandle) -> u64 {
    fn walk(p: &std::path::Path) -> u64 {
        let mut total = 0;
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.filter_map(|e| e.ok()) {
                let path = e.path();
                if path.is_dir() {
                    if path.file_name().map_or(false, |n| n == "EBWebView") {
                        continue;
                    }
                    total += walk(&path);
                } else if let Ok(m) = e.metadata() {
                    total += m.len();
                }
            }
        }
        total
    }
    match app.path().app_data_dir() {
        Ok(dir) => walk(&dir),
        Err(_) => 0,
    }
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
            import_board,
            save_image,
            load_image,
            delete_image,
            attach_file,
            put_file,
            read_file,
            file_path,
            delete_file,
            sync_code,
            set_sync_code,
            sync_email,
            set_sync_email,
            park_conflict,
            usage,
            cache_size
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
