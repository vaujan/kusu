#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod preview_media;
mod preview_text;
mod preview_vault;
mod vault_records;

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use preview_media::PreviewMedia;
use preview_text::TextUpdate;
use preview_vault::web_url;
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct PreviewSession {
    id: u32,
    media: Arc<PreviewMedia>,
    _watcher: Option<Debouncer<RecommendedWatcher>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedPreview {
    session_id: Option<u32>,
    library: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewTextChanged<'a> {
    session_id: u32,
    paths: Vec<&'a Path>,
}

fn selection_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("preview-vault.json"))
        .map_err(|error| error.to_string())
}

fn start_preview_session(
    state: &Mutex<Option<PreviewSession>>,
    app: &tauri::AppHandle,
    snapshot: &Path,
    library: Value,
) -> Result<OpenedPreview, String> {
    static NEXT_SESSION_ID: AtomicU32 = AtomicU32::new(1);
    let session = PreviewMedia::from_snapshot(snapshot, &library).map(|media| {
        let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let watcher = watch_preview_text(app.clone(), media.root().to_owned(), id)
            .inspect_err(|error| eprintln!("Could not watch the preview vault: {error}"))
            .ok();
        PreviewSession {
            id,
            media: Arc::new(media),
            _watcher: watcher,
        }
    });
    let session_id = session.as_ref().map(|session| session.id);
    *state.lock().map_err(|error| error.to_string())? = session;
    Ok(OpenedPreview {
        session_id,
        library,
    })
}

fn watch_preview_text(
    app: tauri::AppHandle,
    root: PathBuf,
    session_id: u32,
) -> Result<Debouncer<RecommendedWatcher>, notify_debouncer_mini::notify::Error> {
    let watched_root = root.clone();
    let mut watcher = new_debouncer(
        Duration::from_millis(180),
        move |result: DebounceEventResult| {
            let Ok(events) = result else {
                return;
            };
            let paths: Vec<_> = events
                .iter()
                .filter_map(|event| event.path.strip_prefix(&watched_root).ok())
                .filter(|path| {
                    !path
                        .components()
                        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
                })
                .collect();
            if !paths.is_empty() {
                let _ = app.emit_to(
                    "main",
                    "kusu:preview-text-changed",
                    PreviewTextChanged { session_id, paths },
                );
            }
        },
    )?;
    watcher.watcher().watch(&root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn active_preview(media: &Mutex<Option<PreviewSession>>) -> Result<Arc<PreviewMedia>, String> {
    media
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(|session| Arc::clone(&session.media))
        .ok_or_else(|| "Open an indexed test vault first.".into())
}

#[tauri::command]
async fn load_preview_snapshot(
    app: tauri::AppHandle,
    media: tauri::State<'_, Mutex<Option<PreviewSession>>>,
) -> Result<Option<OpenedPreview>, String> {
    let selection = selection_path(&app)?;
    let opened = tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = std::env::var_os("KUSU_TAURI_SNAPSHOT") {
            preview_vault::read_preview_source(Path::new(&path)).map(Some)
        } else if let Some(vault) = preview_vault::saved_selection(&selection)? {
            preview_vault::read_vault(&vault)
                .map(Some)
                .map_err(|error| format!("{} — {error}", vault.display()))
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|error| error.to_string())??;
    let Some((snapshot, library)) = opened else {
        return Ok(None);
    };
    start_preview_session(&media, &app, &snapshot, library).map(Some)
}

#[tauri::command]
async fn open_preview_vault(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    media: tauri::State<'_, Mutex<Option<PreviewSession>>>,
) -> Result<Option<OpenedPreview>, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Open a test vault")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let vault = selected.into_path().map_err(|error| error.to_string())?;
    let selection = selection_path(&app)?;
    let (snapshot, library) = tauri::async_runtime::spawn_blocking(move || {
        let opened = preview_vault::read_vault(&vault)?;
        preview_vault::save_selection(&selection, &vault)?;
        Ok::<_, String>(opened)
    })
    .await
    .map_err(|error| error.to_string())??;
    start_preview_session(&media, &app, &snapshot, library).map(Some)
}

#[tauri::command]
async fn read_preview_media(
    item_id: String,
    attachment_id: Option<String>,
    thumbnail: bool,
    media: tauri::State<'_, Mutex<Option<PreviewSession>>>,
) -> Result<tauri::ipc::Response, String> {
    let preview = active_preview(&media)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || match attachment_id {
        Some(attachment_id) => preview.read_attachment(&item_id, &attachment_id),
        None => preview.read(&item_id, thumbnail),
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn refresh_preview_text(
    session_id: u32,
    paths: Option<Vec<PathBuf>>,
    media: tauri::State<'_, Mutex<Option<PreviewSession>>>,
) -> Result<Vec<TextUpdate>, String> {
    let preview = preview_for_session(&media, session_id)?;
    let Some(preview) = preview else {
        return Ok(Vec::new());
    };
    let updates =
        tauri::async_runtime::spawn_blocking(move || preview.refresh_text(paths.as_deref()))
            .await
            .map_err(|error| error.to_string())?;
    if preview_for_session(&media, session_id)?.is_none() {
        return Ok(Vec::new());
    }
    updates
}

fn preview_for_session(
    state: &Mutex<Option<PreviewSession>>,
    session_id: u32,
) -> Result<Option<Arc<PreviewMedia>>, String> {
    Ok(state
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .filter(|session| session.id == session_id)
        .map(|session| Arc::clone(&session.media)))
}

#[tauri::command]
async fn show_preview_item(
    item_id: String,
    reveal: bool,
    media: tauri::State<'_, Mutex<Option<PreviewSession>>>,
) -> Result<(), String> {
    let preview = active_preview(&media)?;
    tauri::async_runtime::spawn_blocking(move || {
        if reveal {
            tauri_plugin_opener::reveal_item_in_dir(preview.reveal_path(&item_id)?)
        } else {
            tauri_plugin_opener::open_path(preview.image_open_path(&item_id)?, None::<&str>)
        }
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn is_app_navigation(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    if let Some(dev_url) = dev_url {
        return url.origin() == dev_url.origin();
    }
    url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("http", Some("tauri.localhost")) | ("tauri", Some("localhost"))
        )
}

#[tauri::command]
async fn open_preview_link(url: String) -> Result<(), String> {
    let url = web_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(None::<PreviewSession>))
        .setup(|app| {
            let config = app.config();
            let dev_url = if tauri::is_dev() {
                config.build.dev_url.clone()
            } else {
                None
            };
            tauri::WebviewWindowBuilder::from_config(app, &config.app.windows[0])?
                .on_navigation(move |url| is_app_navigation(url, dev_url.as_ref()))
                .on_new_window(|url, _| {
                    if let Ok(url) = web_url(url.as_str()) {
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
                        });
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_preview_snapshot,
            open_preview_vault,
            read_preview_media,
            refresh_preview_text,
            show_preview_item,
            open_preview_link
        ])
        .run(tauri::generate_context!())
        .expect("Unable to run the Kusu Tauri preview");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_http_and_https_links() {
        assert_eq!(web_url("https://example.test").unwrap().scheme(), "https");
        assert_eq!(web_url("http://127.0.0.1:9").unwrap().scheme(), "http");
        for invalid in [
            "file:///C:/local",
            "javascript:alert(1)",
            "mailto:a@example.test",
            "not a URL",
        ] {
            assert!(web_url(invalid).is_err());
        }
    }

    #[test]
    fn confines_the_webview_to_the_app_origin() {
        let url = |value| tauri::Url::parse(value).unwrap();
        assert!(is_app_navigation(
            &url("http://tauri.localhost/?surface=main"),
            None
        ));
        assert!(is_app_navigation(&url("tauri://localhost/"), None));
        assert!(!is_app_navigation(&url("https://example.test/"), None));
        assert!(!is_app_navigation(
            &url("http://tauri.localhost:1420/"),
            None
        ));
        let dev = url("http://127.0.0.1:1420/");
        assert!(is_app_navigation(
            &url("http://127.0.0.1:1420/?surface=main"),
            Some(&dev)
        ));
        assert!(!is_app_navigation(
            &url("http://127.0.0.1:1421/"),
            Some(&dev)
        ));
    }
}
