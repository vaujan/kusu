use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::preview_vault::{
    file_identity, is_item_id, resolve_vault_file, same_path, web_url, FileIdentity,
};

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum TextUpdate {
    Note {
        id: String,
        relative_path: String,
        body: String,
        missing_content: bool,
        updated_at_ms: Option<i64>,
    },
    Url {
        id: String,
        relative_path: String,
        source_url: String,
        domain: String,
        content_kind: &'static str,
        error: Option<&'static str>,
        updated_at_ms: Option<i64>,
    },
}

#[derive(Clone, Copy)]
enum TextKind {
    Note,
    Bookmark,
}

pub struct IndexedText {
    id: String,
    path: PathBuf,
    display_path: String,
    kind: TextKind,
    content_hash: Option<[u8; 32]>,
    note_fingerprint: Option<(u64, [u8; 32])>,
    note_identity: Option<FileIdentity>,
    can_move_between_folders: bool,
    file_version: Option<(u64, SystemTime)>,
}

impl IndexedText {
    pub fn from_item(item: &Value) -> Option<Self> {
        let (kind, content) = match item["type"].as_str()? {
            "note" => (TextKind::Note, item["body"].as_str()?),
            "url" => (TextKind::Bookmark, item["sourceUrl"].as_str()?),
            _ => return None,
        };
        let content_hash = if item["missingContent"].as_bool() == Some(true) {
            None
        } else {
            Some(hash_text(content))
        };
        let relative_path = item["relativePath"].as_str()?;
        let note_fingerprint = match (kind, content_hash) {
            (TextKind::Note, Some(hash)) if item["bodyTruncated"].as_bool() != Some(true) => {
                Some((content.len() as u64, hash))
            }
            _ => None,
        };
        Some(Self {
            id: item["id"].as_str()?.to_owned(),
            path: PathBuf::from(relative_path),
            display_path: relative_path.to_owned(),
            kind,
            content_hash,
            note_fingerprint,
            note_identity: None,
            can_move_between_folders: item["attachments"].as_array().is_none_or(Vec::is_empty)
                && item["location"]["type"] != "trash",
            file_version: None,
        })
    }

    pub fn refresh(
        &mut self,
        root: &Path,
        inventory: Option<&HashSet<PathBuf>>,
    ) -> Option<TextUpdate> {
        let entry = resolve_vault_file(root, &self.path)
            .and_then(|path| fs::metadata(&path).map(|metadata| (path, metadata)));
        let Ok((path, metadata)) = entry else {
            return self.mark_missing();
        };
        let relative = path.strip_prefix(root).ok()?;
        if inventory.is_some_and(|files| {
            !relative.starts_with(".kuskus/trash") && !files.contains(relative)
        }) {
            return self.mark_missing();
        }
        let display_path = relative
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let path_changed = display_path != self.display_path;
        let version = metadata
            .modified()
            .ok()
            .map(|modified| (metadata.len(), modified));
        if !path_changed && version.is_some() && version == self.file_version {
            return None;
        }
        let Ok(mut file) = File::open(path) else {
            self.file_version = None;
            return self.mark_unavailable("The saved file could not be read.");
        };
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_err() {
            self.file_version = None;
            return self.mark_unavailable("The saved file could not be read.");
        }
        self.file_version = version;
        self.display_path = display_path;
        let source = String::from_utf8_lossy(&bytes);
        let updated_at = version
            .and_then(|(_, modified)| modified.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok());
        match self.kind {
            TextKind::Note => {
                self.note_identity = file_identity(&file);
                self.note_fingerprint = Some((bytes.len() as u64, Sha256::digest(&bytes).into()));
                (self.record_change(&source) || path_changed)
                    .then(|| self.note_update(Some(&source), updated_at))
            }
            TextKind::Bookmark => match parse_shortcut(&source) {
                Ok(url) => {
                    (self.record_change(url.as_str()) || path_changed).then(|| TextUpdate::Url {
                        id: self.id.clone(),
                        relative_path: self.display_path.clone(),
                        source_url: url.as_str().to_owned(),
                        domain: url.host_str().unwrap_or_default().to_owned(),
                        content_kind: if is_youtube_video(&url) {
                            "video"
                        } else {
                            "webpage"
                        },
                        error: None,
                        updated_at_ms: updated_at,
                    })
                }
                Err(error) => self.mark_unavailable(error),
            },
        }
    }

    pub fn is_affected_by(&self, paths: &[PathBuf]) -> bool {
        paths.iter().any(|path| {
            self.path.starts_with(path)
                || self
                    .path
                    .ancestors()
                    .any(|ancestor| same_path(ancestor, path))
        })
    }

    pub fn might_have_moved(&self, root: &Path, paths: &[PathBuf]) -> bool {
        matches!(self.kind, TextKind::Note)
            && (self.is_affected_by(paths)
                || (self.content_hash.is_none()
                    && paths.iter().any(|path| {
                        path.parent() == self.path.parent()
                            || (self.can_move_between_folders
                                && (self.note_identity.is_some() || is_item_id(&self.id))
                                && path
                                    .extension()
                                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md")))
                    })))
            && self.is_missing_on_disk(root)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn is_missing_on_disk(&self, root: &Path) -> bool {
        matches!(
            resolve_vault_file(root, &self.path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        )
    }

    fn recorded_identity(&self, root: &Path) -> Option<FileIdentity> {
        if !is_item_id(&self.id) {
            return None;
        }
        let relative = Path::new(".kuskus/records").join(format!("{}.json", self.id));
        let record = resolve_vault_file(root, &relative).ok()?;
        let record: Value = serde_json::from_reader(File::open(record).ok()?).ok()?;
        if record["schemaVersion"].as_u64() != Some(2)
            || record["id"].as_str()? != self.id
            || Path::new(record["relativePath"].as_str()?) != self.path
            || record["metadata"]["type"].as_str()? != "note"
        {
            return None;
        }
        let (volume, index) = record["fileIdentity"].as_str()?.split_once(':')?;
        let index = index.parse().ok()?;
        (index != 0).then_some((volume.parse().ok()?, index))
    }

    fn mark_missing(&mut self) -> Option<TextUpdate> {
        self.file_version = None;
        self.mark_unavailable("The saved file is unavailable.")
    }

    fn record_change(&mut self, content: &str) -> bool {
        let hash = Some(hash_text(content));
        let changed = self.content_hash != hash;
        self.content_hash = hash;
        changed
    }

    fn mark_unavailable(&mut self, error: &'static str) -> Option<TextUpdate> {
        self.content_hash.take().map(|_| match self.kind {
            TextKind::Note => self.note_update(None, None),
            TextKind::Bookmark => TextUpdate::Url {
                id: self.id.clone(),
                relative_path: self.display_path.clone(),
                source_url: String::new(),
                domain: String::new(),
                content_kind: "webpage",
                error: Some(error),
                updated_at_ms: None,
            },
        })
    }

    fn note_update(&self, body: Option<&str>, updated_at: Option<i64>) -> TextUpdate {
        TextUpdate::Note {
            id: self.id.clone(),
            relative_path: self.display_path.clone(),
            body: body.unwrap_or_default().to_owned(),
            missing_content: body.is_none(),
            updated_at_ms: updated_at,
        }
    }
}

#[derive(Eq, Hash, PartialEq)]
enum RenameKey {
    Identity(FileIdentity),
    Fingerprint(PathBuf, [u8; 32]),
}

pub fn reconcile_note_renames(
    root: &Path,
    texts: &mut [IndexedText],
    files: &HashSet<PathBuf>,
    indexed_paths: impl Iterator<Item = PathBuf>,
    known_folders: &HashSet<PathBuf>,
) {
    let mut missing = HashMap::new();
    let mut fingerprint_sizes: HashMap<_, HashSet<_>> = HashMap::new();
    let mut needs_identity = false;
    for (index, text) in texts.iter().enumerate() {
        if !matches!(text.kind, TextKind::Note)
            || files.contains(&text.path)
            || !text.is_missing_on_disk(root)
        {
            continue;
        }
        let Some(parent) = text.path.parent() else {
            continue;
        };
        let identity = text.note_identity.or_else(|| text.recorded_identity(root));
        needs_identity |= identity.is_some();
        let fingerprint = text.note_fingerprint.map(|(size, hash)| {
            fingerprint_sizes
                .entry(parent.to_owned())
                .or_default()
                .insert(size);
            RenameKey::Fingerprint(parent.to_owned(), hash)
        });
        for key in [identity.map(RenameKey::Identity), fingerprint]
            .into_iter()
            .flatten()
        {
            missing
                .entry(key)
                .and_modify(|candidate| *candidate = None)
                .or_insert(Some(index));
        }
    }
    if missing.is_empty() {
        return;
    }

    let indexed: Vec<_> = indexed_paths
        .chain(texts.iter().map(|text| text.path.clone()))
        .collect();
    let mut matches = HashMap::new();
    let mut unreadable = HashSet::new();
    for file in files {
        if !file
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let Some(parent) = file.parent() else {
            continue;
        };
        let sizes = fingerprint_sizes.get(parent);
        if !needs_identity && sizes.is_none() {
            continue;
        }
        let Ok(path) = resolve_vault_file(root, file) else {
            unreadable.insert(parent);
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            unreadable.insert(parent);
            continue;
        };
        let needs_hash = sizes.is_some_and(|sizes| sizes.contains(&metadata.len()));
        if !needs_identity && !needs_hash {
            continue;
        }
        let Ok(mut file_handle) = File::open(path) else {
            unreadable.insert(parent);
            continue;
        };
        let identity = if needs_identity {
            file_identity(&file_handle).map(RenameKey::Identity)
        } else {
            None
        };
        let fingerprint = if needs_hash {
            let mut bytes = Vec::new();
            if file_handle.read_to_end(&mut bytes).is_err() {
                unreadable.insert(parent);
                continue;
            }
            Some(RenameKey::Fingerprint(
                parent.to_owned(),
                Sha256::digest(&bytes).into(),
            ))
        } else {
            None
        };
        for (by_identity, key) in [identity, fingerprint].into_iter().enumerate() {
            let Some(index) = key.and_then(|key| missing.get(&key).copied().flatten()) else {
                continue;
            };
            matches
                .entry((by_identity, index))
                .and_modify(|candidate| *candidate = None)
                .or_insert(Some(file));
        }
    }
    let mut matches: Vec<_> = matches.into_iter().collect();
    matches.sort_unstable_by_key(|(priority, _)| *priority);
    let mut assigned_indices = HashSet::new();
    let mut assigned_paths = HashSet::new();
    for ((priority, index), candidate) in matches {
        if let Some(path) = candidate.filter(|path| {
            let parent = path.parent().unwrap_or(Path::new(""));
            let same_folder = path.parent() == texts[index].path.parent();
            let known_destination = parent.as_os_str().is_empty()
                || parent.starts_with("Archive")
                || known_folders.contains(parent);
            (same_folder || (texts[index].can_move_between_folders && known_destination))
                && (priority != 0 || unreadable.is_empty())
                && !unreadable.contains(parent)
                && !indexed.iter().any(|known| same_path(known, path))
                && !assigned_indices.contains(&index)
                && !assigned_paths.contains(path)
        }) {
            assigned_indices.insert(index);
            assigned_paths.insert(path);
            texts[index].path = path.clone();
            texts[index].file_version = None;
        }
    }
}

fn hash_text(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

pub(crate) fn parse_shortcut(source: &str) -> Result<Url, &'static str> {
    let mut lines = source.strip_prefix('\u{feff}').unwrap_or(source).lines();
    if !lines.any(|line| line.trim().eq_ignore_ascii_case("[InternetShortcut]")) {
        return Err("The Internet Shortcut section is missing.");
    }
    for line in lines
        .map(str::trim)
        .take_while(|line| !line.starts_with('['))
    {
        if let Some((key, value)) = line.split_once('=') {
            let value = value.trim();
            if key.trim().eq_ignore_ascii_case("URL") && !value.is_empty() {
                return web_url(value).map_err(|_| "The Internet Shortcut URL is invalid.");
            }
        }
    }
    Err("The Internet Shortcut URL is missing.")
}

pub(crate) fn is_youtube_video(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let host = host.strip_prefix("www.").unwrap_or(host);
    let mut path = url.path().split('/').skip(1);
    let video_id = match (host, path.next()) {
        ("youtu.be", id) => id,
        ("youtube.com" | "m.youtube.com", Some("shorts" | "embed")) => path.next(),
        ("youtube.com" | "m.youtube.com", Some("watch")) if url.path() == "/watch" => {
            return url
                .query_pairs()
                .find(|(key, _)| key == "v")
                .is_some_and(|(_, id)| is_video_id(&id));
        }
        _ => None,
    };
    video_id.is_some_and(is_video_id)
}

fn is_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn serialized_update(item: &mut IndexedText, root: &Path) -> Value {
        serde_json::to_value(item.refresh(root, None).unwrap()).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn refreshes_case_only_renames_under_the_indexed_id() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        fs::create_dir(root.join("Notes")).unwrap();
        let original = root.join("Notes/Résumé.md");
        let intermediate = root.join("Temporary.md");
        let renamed = root.join("Notes/RÉSUMÉ.md");
        fs::write(&original, "# Original").unwrap();
        let snapshot_item = json!({
            "id": "note-id", "type": "note", "relativePath": "Notes/Résumé.md", "body": "# Original"
        });
        let mut note = IndexedText::from_item(&snapshot_item).unwrap();
        assert!(note.refresh(&root, None).is_none());
        fs::rename(original, &intermediate).unwrap();
        fs::rename(intermediate, renamed).unwrap();
        assert!(note.is_affected_by(&[PathBuf::from(r"Notes\RÉSUMÉ.md")]));
        let update = serialized_update(&mut note, &root);
        assert_eq!(update["id"], "note-id");
        assert_eq!(update["relativePath"], "Notes/RÉSUMÉ.md");
        assert_eq!(update["body"], "# Original");
        let mut reopened = IndexedText::from_item(&snapshot_item).unwrap();
        let inventory = crate::preview_vault::visible_files(&root).unwrap();
        let update =
            serde_json::to_value(reopened.refresh(&root, Some(&inventory)).unwrap()).unwrap();
        assert_eq!(update["id"], "note-id");
        assert_eq!(update["relativePath"], "Notes/RÉSUMÉ.md");
    }

    #[test]
    fn parses_only_web_urls_from_the_internet_shortcut_section() {
        let url = parse_shortcut("\u{feff}[other]\r\nURL=https://ignored.test/\r\n [internetshortcut] \r\n uRl = HTTPS://Example.test?q=1\r\n").unwrap();
        assert_eq!(url.as_str(), "https://example.test/?q=1");
        assert!(parse_shortcut("[InternetShortcut]\nURL=file:///C:/Windows").is_err());
        assert!(parse_shortcut("[InternetShortcut]\n[other]\nURL=https://example.test").is_err());
        assert!(parse_shortcut("URL=https://example.test").is_err());
    }

    #[test]
    fn refreshes_bookmark_targets_and_disables_malformed_shortcuts_until_repaired() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let path = root.join("Bookmark.url");
        fs::write(&path, "[InternetShortcut]\nURL=https://old.test/").unwrap();
        let mut bookmark = IndexedText::from_item(&json!({
            "type": "url", "id": "bookmark", "relativePath": "Bookmark.url", "sourceUrl": "https://old.test/"
        }))
        .unwrap();
        assert!(bookmark.refresh(&root, None).is_none());
        fs::write(
            &path,
            "[InternetShortcut]\nURL=https://youtu.be/abcdefghijk",
        )
        .unwrap();
        let update = serialized_update(&mut bookmark, &root);
        assert_eq!(update["type"], "url");
        assert_eq!(update["id"], "bookmark");
        assert_eq!(update["sourceUrl"], "https://youtu.be/abcdefghijk");
        assert_eq!(update["contentKind"], "video");
        fs::write(&path, "[InternetShortcut]\nURL=javascript:alert(1)").unwrap();
        let invalid = serialized_update(&mut bookmark, &root);
        assert_eq!(invalid["sourceUrl"], "");
        assert!(invalid["error"].is_string());
        assert!(bookmark.refresh(&root, None).is_none());
        fs::write(
            &path,
            "[InternetShortcut]\nURL=https://repaired.test/articles",
        )
        .unwrap();
        let repaired = serialized_update(&mut bookmark, &root);
        assert_eq!(repaired["domain"], "repaired.test");
        assert_eq!(repaired["contentKind"], "webpage");
        assert!(repaired["error"].is_null());
    }

    #[test]
    fn refreshes_changed_and_missing_notes_without_writing_files() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let path = root.join("Note.md");
        fs::write(&path, "# Original").unwrap();
        let mut note = IndexedText::from_item(&json!({
            "type": "note", "id": "note", "relativePath": "Note.md", "body": "# Original"
        }))
        .unwrap();
        assert!(note.refresh(&root, None).is_none());
        fs::write(&path, "# Externally edited").unwrap();
        assert_eq!(
            serialized_update(&mut note, &root)["body"],
            "# Externally edited"
        );
        assert!(note.refresh(&root, None).is_none());
        fs::remove_file(&path).unwrap();
        assert_eq!(serialized_update(&mut note, &root)["missingContent"], true);
        assert!(note.refresh(&root, None).is_none());
        fs::write(&path, "# Restored").unwrap();
        assert_eq!(serialized_update(&mut note, &root)["body"], "# Restored");
    }

    #[test]
    fn refuses_an_indexed_path_outside_the_selected_vault() {
        let fixture = tempfile::tempdir().unwrap();
        let vault = fixture.path().join("Vault");
        fs::create_dir(&vault).unwrap();
        fs::write(fixture.path().join("Outside.md"), "# Outside the vault").unwrap();
        let mut note = IndexedText::from_item(&json!({
            "type": "note", "id": "note", "relativePath": "../Outside.md", "body": "# Stale"
        }))
        .unwrap();
        let update = serialized_update(&mut note, &vault.canonicalize().unwrap());
        assert_eq!(update["type"], "note");
        assert_eq!(update["missingContent"], true);
        assert_eq!(update["body"], "");
    }
}
