use base64::{engine::general_purpose, Engine as _};
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
            usage
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
