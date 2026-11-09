use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Write},
    path::{Component, Path, PathBuf},
};

use serde_json::Value;
use url::Url;

const SNAPSHOT: &str = ".kuskus/index/library-v1.json";

pub type FileIdentity = (u64, u64);

#[cfg(windows)]
pub fn file_identity(file: &File) -> Option<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // The handle remains open and info points to a writable structure for the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return None;
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    (index != 0).then_some((u64::from(info.dwVolumeSerialNumber), index))
}

#[cfg(unix)]
pub fn file_identity(file: &File) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata().ok()?;
    (metadata.ino() != 0).then_some((metadata.dev(), metadata.ino()))
}

pub fn is_item_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

pub fn visible_files(root: &Path) -> io::Result<HashSet<PathBuf>> {
    let mut files = HashSet::new();
    let mut directories = vec![PathBuf::new()];
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(root.join(&directory))? {
            let entry = entry?;
            let name = entry.file_name();
            if name.as_encoded_bytes().starts_with(b".") {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                directories.push(directory.join(name));
            } else if file_type.is_file()
                && !name
                    .as_encoded_bytes()
                    .ends_with(b".kuskus-initialize-backup")
            {
                files.insert(directory.join(name));
            }
        }
    }
    Ok(files)
}

pub fn web_url(value: &str) -> Result<Url, &'static str> {
    let url = Url::parse(value).map_err(|_| "The link is invalid.")?;
    if !matches!(url.scheme(), "http" | "https") || !url.has_host() {
        return Err("Only web links can be opened.");
    }
    Ok(url)
}

pub fn saved_selection(selection: &Path) -> Result<Option<PathBuf>, String> {
    match fs::read(selection) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save_selection(selection: &Path, vault: &Path) -> Result<(), String> {
    let directory = selection
        .parent()
        .ok_or("Invalid preview settings directory.")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    serde_json::to_writer(temporary.as_file_mut(), vault).map_err(|error| error.to_string())?;
    temporary.flush().map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(selection)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn read_vault(vault: &Path) -> Result<(PathBuf, Value), String> {
    let root = vault.canonicalize().map_err(|error| error.to_string())?;
    let manifest = vault_file(&root, ".kuskus/library.json")?;
    let manifest: Value =
        serde_json::from_slice(&fs::read(manifest).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if manifest["schemaVersion"].as_u64() != Some(2) || manifest["id"].as_str().is_none() {
        return Err("The vault manifest has an unsupported format.".into());
    }
    let snapshot = root.join(SNAPSHOT);
    let mut library = resolve_vault_file(&root, Path::new(SNAPSHOT))
        .ok()
        .and_then(|path| read_snapshot(&path).ok())
        .map(|(_, library)| library)
        .filter(|library| library["id"] == manifest["id"])
        .map(Ok)
        .unwrap_or_else(|| crate::vault_records::read_library(&root, &manifest))?;
    library["path"] = Value::String(vault.to_string_lossy().into_owned());
    Ok((snapshot, library))
}

fn vault_file(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    resolve_vault_file(root, Path::new(relative_path))
        .map_err(|_| "Open a test vault with its saved Kusu metadata and index.".to_owned())
}

pub fn resolve_vault_file(root: &Path, relative_path: &Path) -> io::Result<PathBuf> {
    resolve_vault_entry(root, relative_path, false)
}

pub fn resolve_vault_directory(root: &Path, relative_path: &Path) -> io::Result<PathBuf> {
    resolve_vault_entry(root, relative_path, true)
}

fn resolve_vault_entry(root: &Path, relative_path: &Path, directory: bool) -> io::Result<PathBuf> {
    if relative_path.as_os_str().is_empty() {
        return Err(io::Error::other("The vault path is invalid."));
    }
    let mut expected = root.to_owned();
    let mut components = relative_path.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(io::Error::other("The vault path is invalid."));
        };
        // A Windows drive prefix or alternate stream can appear inside a relative path.
        #[cfg(windows)]
        if name.as_encoded_bytes().contains(&b':') {
            return Err(io::Error::other("The vault path is invalid."));
        }
        expected.push(name);
        let metadata = expected.symlink_metadata()?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::other(
                "The vault path contains a filesystem link.",
            ));
        }
        if components.peek().is_none()
            && !(if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            })
        {
            return Err(io::Error::other("The vault path has the wrong entry type."));
        }
    }
    let actual = expected.canonicalize()?;
    if !actual.starts_with(root) || !same_path(&actual, &expected) {
        return Err(io::Error::other(
            "The vault path changed during resolution.",
        ));
    }
    Ok(actual)
}

pub fn same_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    #[cfg(windows)]
    {
        let mut right = right.components();
        for left in left.components() {
            let Some(right) = right.next() else {
                return false;
            };
            if left != right
                && !matches!(
                    (left.as_os_str().to_str(), right.as_os_str().to_str()),
                    (Some(left), Some(right)) if left.to_lowercase() == right.to_lowercase()
                )
            {
                return false;
            }
        }
        return right.next().is_none();
    }
    #[cfg(not(windows))]
    false
}

pub fn read_snapshot(path: &Path) -> Result<(PathBuf, Value), String> {
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let mut snapshot: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let library = snapshot["library"].take();
    if snapshot["schemaVersion"].as_u64() != Some(1)
        || library["schemaVersion"].as_u64() != Some(2)
        || !library["items"].is_array()
        || !library["collections"].is_array()
    {
        return Err("Expected a Kusu library-v1.json snapshot.".into());
    }
    Ok((path, library))
}

pub fn read_preview_source(path: &Path) -> Result<(PathBuf, Value), String> {
    // A vault's index is disposable, including when explicitly selected for a preview run.
    if let Some(metadata) = path.parent().and_then(Path::parent) {
        if path
            .file_name()
            .is_some_and(|name| name == "library-v1.json")
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "index")
            && metadata.file_name().is_some_and(|name| name == ".kuskus")
        {
            return read_vault(metadata.parent().ok_or("Invalid vault location.")?);
        }
    }
    read_snapshot(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inventories_visible_files_including_archive_and_unicode() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path();
        for path in [
            "Inbox.md",
            "Archive/Older.url",
            "Café/Notes/Résumé.md",
            "Café/image.png",
            "Café/.hidden/Hidden.md",
            ".obsidian/Workspace.md",
            ".kuskus/trash/Trashed.md",
            ".hidden.md",
            "Inbox.md.kuskus-initialize-backup",
        ] {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "fixture").unwrap();
        }
        assert_eq!(
            visible_files(root).unwrap(),
            [
                "Inbox.md",
                "Archive/Older.url",
                "Café/Notes/Résumé.md",
                "Café/image.png"
            ]
            .into_iter()
            .map(PathBuf::from)
            .collect()
        );
    }

    #[test]
    fn resolves_only_files_at_contained_relative_paths() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        fs::create_dir(root.join("Café")).unwrap();
        let note = root.join("Café").join("Résumé.md");
        fs::write(&note, "Content").unwrap();
        assert_eq!(
            resolve_vault_file(&root, Path::new("Café/Résumé.md")).unwrap(),
            note
        );
        for invalid in ["", ".", "Café", "Café/../Café/Résumé.md", "Missing.md"] {
            assert!(resolve_vault_file(&root, Path::new(invalid)).is_err());
        }
        assert!(resolve_vault_file(&root, &note).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_alternate_data_streams_and_embedded_drive_prefixes() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        fs::create_dir(root.join("Folder")).unwrap();
        let note = root.join("Folder").join("Note.md");
        fs::write(&note, "Ordinary content").unwrap();
        fs::write(note.with_file_name("Note.md:hidden"), "Hidden stream").unwrap();
        for invalid in ["Folder/Note.md:hidden", "Folder/C:Note.md"] {
            let error = resolve_vault_file(&root, Path::new(invalid)).unwrap_err();
            assert_eq!(error.to_string(), "The vault path is invalid.");
        }
    }

    #[test]
    fn replaces_a_saved_selection_and_preserves_unicode_paths() {
        let profile = tempfile::tempdir().unwrap();
        let selection = profile.path().join("profile/preview-vault.json");
        let first = profile.path().join("Café");
        let second = profile.path().join("Archive");
        assert_eq!(saved_selection(&selection).unwrap(), None);
        save_selection(&selection, &first).unwrap();
        assert_eq!(
            saved_selection(&selection).unwrap().as_deref(),
            Some(first.as_path())
        );
        save_selection(&selection, &second).unwrap();
        assert_eq!(
            saved_selection(&selection).unwrap().as_deref(),
            Some(second.as_path())
        );
    }

    #[test]
    fn opens_a_copied_vault_at_its_selected_location() {
        let vault = tempfile::tempdir().unwrap();
        assert!(read_vault(vault.path()).is_err());
        let path = vault.path().join(SNAPSHOT);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let snapshot = json!({
            "schemaVersion": 1,
            "library": { "schemaVersion": 2, "id": "vault-id", "path": "original-vault", "items": [], "collections": [] }
        });
        let manifest = vault.path().join(".kuskus/library.json");
        fs::write(&manifest, r#"{"schemaVersion":2,"id":"another-vault"}"#).unwrap();
        fs::write(&path, snapshot.to_string()).unwrap();
        assert!(read_vault(vault.path()).is_err());
        fs::write(&manifest, r#"{"schemaVersion":2,"id":"vault-id"}"#).unwrap();
        let (snapshot_path, library) = read_vault(vault.path()).unwrap();
        assert_eq!(snapshot_path, path.canonicalize().unwrap());
        assert_eq!(library["path"].as_str(), vault.path().to_str());
    }
}
