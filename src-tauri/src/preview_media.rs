use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use image::{ImageFormat, ImageReader};
use serde_json::Value;

use crate::{
    preview_text::{reconcile_note_renames, IndexedText, TextUpdate},
    preview_vault::{is_item_id, resolve_vault_file, visible_files},
};

const THUMBNAIL_EDGE: u32 = 512;

pub struct PreviewMedia {
    root: PathBuf,
    paths: HashMap<String, MediaEntry>,
    attachments: HashMap<String, HashMap<String, (PathBuf, &'static str)>>,
    texts: Mutex<Vec<IndexedText>>,
    known_folders: HashSet<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
struct MediaEntry {
    relative_path: PathBuf,
    media_type: Option<&'static str>,
    thumbnail_key: Option<String>,
}

impl PreviewMedia {
    pub fn from_snapshot(snapshot: &Path, library: &Value) -> Option<Self> {
        let index = snapshot.parent()?;
        let metadata = index.parent()?;
        if snapshot.file_name()? != "library-v1.json"
            || index.file_name()? != "index"
            || metadata.file_name()? != ".kuskus"
        {
            return None;
        }
        let items = library["items"].as_array()?;
        let paths = items
            .iter()
            .filter_map(|item| {
                let id = item["id"].as_str()?;
                let relative_path = Path::new(item["relativePath"].as_str()?);
                if !relative_path
                    .components()
                    .all(|component| matches!(component, Component::Normal(_)))
                {
                    return None;
                }
                let media_type = match item["type"].as_str()? {
                    "image" => image_media_type(item),
                    "file" if is_pdf(item, relative_path) => Some("application/pdf"),
                    "file" | "note" | "url" => None,
                    _ => return None,
                };
                Some((
                    id.to_owned(),
                    MediaEntry {
                        relative_path: relative_path.to_owned(),
                        media_type,
                        thumbnail_key: thumbnail_key(item),
                    },
                ))
            })
            .collect();
        let attachments = items
            .iter()
            .filter_map(|note| {
                if note["type"].as_str()? != "note" {
                    return None;
                }
                let id = note["id"].as_str()?;
                let directory = Path::new(note["relativePath"].as_str()?).parent()?;
                if !directory
                    .components()
                    .all(|component| matches!(component, Component::Normal(_)))
                {
                    return None;
                }
                let images: HashMap<_, _> = note["attachments"]
                    .as_array()?
                    .iter()
                    .filter_map(|attachment| {
                        if attachment["missingContent"].as_bool() != Some(false) {
                            return None;
                        }
                        let id = attachment["id"].as_str()?;
                        let path = attachment_path(
                            directory,
                            Path::new(attachment["relativePath"].as_str()?),
                        )?;
                        Some((id.to_owned(), (path, image_media_type(attachment)?)))
                    })
                    .collect();
                (!images.is_empty()).then(|| (id.to_owned(), images))
            })
            .collect();
        Some(Self {
            root: metadata.parent()?.to_owned(),
            paths,
            attachments,
            texts: Mutex::new(items.iter().filter_map(IndexedText::from_item).collect()),
            known_folders: library["collections"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|folder| folder["id"].is_string())
                .filter_map(|folder| folder["relativePath"].as_str().map(PathBuf::from))
                .collect(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn refresh_text(&self, paths: Option<&[PathBuf]>) -> Result<Vec<TextUpdate>, String> {
        let mut texts = self.texts.lock().map_err(|error| error.to_string())?;
        let full_refresh = paths.is_none_or(|paths| {
            texts
                .iter()
                .any(|item| item.might_have_moved(&self.root, paths))
        });
        let inventory = full_refresh
            .then(|| visible_files(&self.root))
            .transpose()
            .map_err(|error| error.to_string())?;
        if let Some(files) = &inventory {
            let text_ids: HashSet<_> = texts.iter().map(|item| item.id().to_owned()).collect();
            reconcile_note_renames(
                &self.root,
                &mut texts,
                files,
                self.paths
                    .iter()
                    .filter(|(id, _)| !text_ids.contains(*id))
                    .map(|(_, entry)| entry.relative_path.clone()),
                &self.known_folders,
            );
        }
        Ok(texts
            .iter_mut()
            .filter(|item| full_refresh || paths.is_some_and(|paths| item.is_affected_by(paths)))
            .filter_map(|item| item.refresh(&self.root, inventory.as_ref()))
            .collect())
    }

    pub fn read_attachment(&self, note_id: &str, attachment_id: &str) -> Result<Vec<u8>, String> {
        let (relative_path, media_type) = self
            .attachments
            .get(note_id)
            .and_then(|attachments| attachments.get(attachment_id))
            .ok_or("The saved note has no matching image attachment.")?;
        let path = self.resolve(relative_path)?;
        read_preview(&path, media_type, false)
    }

    pub fn read(&self, item_id: &str, thumbnail: bool) -> Result<Vec<u8>, String> {
        let entry = self
            .paths
            .get(item_id)
            .ok_or("The saved item has no local preview.")?;
        let path = self.resolve(&entry.relative_path)?;
        if thumbnail {
            if let Some(bytes) = self.cached_thumbnail(item_id, entry, &path) {
                return Ok(bytes);
            }
        }
        let media_type = entry
            .media_type
            .ok_or("The saved item has no local preview.")?;
        read_preview(&path, media_type, thumbnail)
    }

    pub fn reveal_path(&self, item_id: &str) -> Result<PathBuf, String> {
        let entry = self
            .paths
            .get(item_id)
            .ok_or("The saved item is unavailable.")?;
        let path = self
            .texts
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .find(|item| item.id() == item_id)
            .map_or_else(
                || entry.relative_path.clone(),
                |item| item.path().to_owned(),
            );
        match self.root.join(&path).symlink_metadata() {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && is_item_id(item_id) => {
                self.resolve(&Path::new(".kuskus/records").join(format!("{item_id}.json")))
            }
            _ => self.resolve(&path),
        }
    }

    pub fn image_open_path(&self, item_id: &str) -> Result<PathBuf, String> {
        let entry = self
            .paths
            .get(item_id)
            .ok_or("The saved image is unavailable.")?;
        let media_type = entry
            .media_type
            .filter(|kind| kind.starts_with("image/"))
            .ok_or("Only saved images can open in the default app.")?;
        let path = self.resolve(&entry.relative_path)?;
        let mut header = Vec::with_capacity(32);
        fs::File::open(&path)
            .and_then(|file| file.take(32).read_to_end(&mut header))
            .map_err(|error| error.to_string())?;
        let format = image::guess_format(&header).map_err(|error| error.to_string())?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if format.to_mime_type() != media_type
            || !format
                .extensions_str()
                .iter()
                .any(|value| extension.eq_ignore_ascii_case(value))
        {
            return Err("The saved file is not a supported image.".into());
        }
        Ok(path)
    }

    fn resolve(&self, relative: &Path) -> Result<PathBuf, String> {
        resolve_vault_file(&self.root, relative).map_err(|error| error.to_string())
    }

    fn cached_thumbnail(&self, id: &str, entry: &MediaEntry, source: &Path) -> Option<Vec<u8>> {
        let expected_key = entry.thumbnail_key.as_deref()?;
        if !is_item_id(id) {
            return None;
        }
        let directory = Path::new(".kuskus/thumbnails").join(id);
        let manifest = self.resolve(&directory.join("image-card.json")).ok()?;
        let thumbnail = self.resolve(&directory.join("image-card.png")).ok()?;
        let metadata = fs::metadata(&thumbnail).ok()?;
        if metadata.len() > 4 * 1024 * 1024
            || fs::metadata(source).ok()?.modified().ok()? > metadata.modified().ok()?
        {
            return None;
        }
        let info: Value = serde_json::from_slice(&fs::read(manifest).ok()?).ok()?;
        if info["sourceKey"].as_str()? != expected_key {
            return None;
        }
        let bytes = fs::read(thumbnail).ok()?;
        let (width, height) = ImageReader::with_format(Cursor::new(&bytes), ImageFormat::Png)
            .into_dimensions()
            .ok()?;
        (width > 0 && height > 0 && width.max(height) <= THUMBNAIL_EDGE).then_some(bytes)
    }
}

fn image_media_type(item: &Value) -> Option<&'static str> {
    match item["mediaType"].as_str()? {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "image/bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn attachment_path(directory: &Path, relative: &Path) -> Option<PathBuf> {
    let mut path = directory.to_owned();
    for component in relative.components() {
        match component {
            Component::Normal(name) => path.push(name),
            Component::CurDir => (),
            Component::ParentDir if path.pop() => (),
            _ => return None,
        }
    }
    (!path.as_os_str().is_empty()).then_some(path)
}

fn thumbnail_key(item: &Value) -> Option<String> {
    if item["type"].as_str()? != "image" {
        return None;
    }
    Some(format!(
        "{}:{}:{}x{}",
        item["relativePath"].as_str()?,
        item["updatedAt"].as_str()?,
        item["width"].as_u64()?,
        item["height"].as_u64()?
    ))
}

fn is_pdf(item: &Value, relative_path: &Path) -> bool {
    item["mediaType"]
        .as_str()
        .and_then(|media_type| media_type.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/pdf"))
        || relative_path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

pub fn read_preview(path: &Path, media_type: &str, thumbnail: bool) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if media_type == "application/pdf" && !thumbnail {
        return Ok(bytes);
    }
    let format = image::guess_format(&bytes).map_err(|error| error.to_string())?;
    if format.to_mime_type() != media_type {
        return Err("The saved image content has changed.".into());
    }
    if !thumbnail {
        return Ok(bytes);
    }
    let decoded = ImageReader::with_format(Cursor::new(bytes), format)
        .decode()
        .map_err(|error| error.to_string())?;
    let thumbnail = if decoded.width().max(decoded.height()) > THUMBNAIL_EDGE {
        decoded.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE)
    } else {
        decoded
    };
    let mut output = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reconciles_attachment_free_notes_moved_to_indexed_folders() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let snapshot = root.join(".kuskus/index/library-v1.json");
        let library = json!({
            "items": [
                {"type": "note", "id": "moved", "relativePath": "Move.md", "body": "Move"},
                {"type": "note", "id": "attached", "relativePath": "Attached.md", "body": "Attached", "attachments": [{"id": "image"}]}
            ],
            "collections": [{"id": "research", "relativePath": "Café"}]
        });
        fs::create_dir(root.join("Café")).unwrap();
        fs::write(root.join("Move.md"), "Move").unwrap();
        fs::write(root.join("Attached.md"), "Attached").unwrap();
        let media = PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        assert!(media.refresh_text(None).unwrap().is_empty());
        let staging = root.join("Move.tmp");
        fs::rename(root.join("Move.md"), &staging).unwrap();
        let removed = serde_json::to_value(
            media
                .refresh_text(Some(&[PathBuf::from("Move.md")]))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(removed[0]["missingContent"], true);
        fs::rename(staging, root.join("Café/Move.md")).unwrap();
        fs::rename(root.join("Attached.md"), root.join("Café/Attached.md")).unwrap();
        let updates = serde_json::to_value(
            media
                .refresh_text(Some(&[PathBuf::from("Café/Move.md")]))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(updates[0]["id"], "moved");
        assert_eq!(updates[0]["relativePath"], "Café/Move.md");
        assert_eq!(updates[1]["id"], "attached");
        assert_eq!(updates[1]["missingContent"], true);
        assert_eq!(
            media.reveal_path("moved").unwrap(),
            root.join("Café/Move.md")
        );
    }

    #[test]
    fn prefers_file_identity_for_a_renamed_and_edited_note() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let snapshot = root.join(".kuskus/index/library-v1.json");
        let id = "21abf42d-b233-478d-a0ca-33a36dc60e24";
        let library = json!({"items": [
            {"type": "note", "id": id, "relativePath": "Old.md", "body": "Original"}
        ]});
        let old = root.join("Old.md");
        let renamed = root.join("Renamed.md");
        fs::write(&old, "Original").unwrap();
        let (volume, index) =
            crate::preview_vault::file_identity(&fs::File::open(&old).unwrap()).unwrap();
        let records = root.join(".kuskus/records");
        fs::create_dir_all(&records).unwrap();
        fs::write(
            records.join(format!("{id}.json")),
            json!({
                "schemaVersion": 2,
                "id": id,
                "relativePath": "Old.md",
                "fileIdentity": format!("{volume}:{index}"),
                "metadata": {"type": "note"}
            })
            .to_string(),
        )
        .unwrap();
        let live = PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        live.refresh_text(None).unwrap();
        fs::rename(&old, &renamed).unwrap();
        fs::write(&renamed, "Edited after rename").unwrap();
        fs::write(root.join("Copy.md"), "Original").unwrap();

        let reopened = PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        for media in [live, reopened] {
            let updates = serde_json::to_value(media.refresh_text(None).unwrap()).unwrap();
            assert_eq!(updates[0]["id"], id);
            assert_eq!(updates[0]["relativePath"], "Renamed.md");
            assert_eq!(updates[0]["body"], "Edited after rename");
        }
    }

    #[test]
    fn reconciles_unique_note_renames_and_leaves_duplicate_matches_unclaimed() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let snapshot = root.join(".kuskus/index/library-v1.json");
        let library = json!({"items": [
            {"type": "note", "id": "renamed", "relativePath": "Old.md", "body": "Unique"},
            {"type": "note", "id": "ambiguous", "relativePath": "Gone.md", "body": "Duplicate"},
            {"type": "note", "id": "claimed", "relativePath": "Missing.md", "body": "Reserved"},
            {"type": "note", "id": "owner", "relativePath": "Present.md", "body": "Reserved"}
        ]});
        fs::write(root.join("Old.md"), "Unique").unwrap();
        fs::write(root.join("One.md"), "Duplicate").unwrap();
        fs::write(root.join("Two.md"), "Duplicate").unwrap();
        fs::write(root.join("Present.md"), "Reserved").unwrap();
        let media = PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        media.refresh_text(None).unwrap();
        fs::rename(root.join("Old.md"), root.join("New.md")).unwrap();

        let updates = serde_json::to_value(
            media
                .refresh_text(Some(&[PathBuf::from("Old.md"), PathBuf::from("New.md")]))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(updates.as_array().unwrap().len(), 1);
        assert_eq!(updates[0]["id"], "renamed");
        assert_eq!(updates[0]["relativePath"], "New.md");
        assert_eq!(media.reveal_path("renamed").unwrap(), root.join("New.md"));

        let reopened = PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        let updates = serde_json::to_value(reopened.refresh_text(None).unwrap()).unwrap();
        assert_eq!(updates[0]["relativePath"], "New.md");
        assert_eq!(updates[1]["missingContent"], true);
        assert_eq!(updates[2]["missingContent"], true);
        fs::rename(root.join("New.md"), root.join("Old.md")).unwrap();
        let updates = serde_json::to_value(
            media
                .refresh_text(Some(&[PathBuf::from("New.md"), PathBuf::from("Old.md")]))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(updates.as_array().unwrap().len(), 1);
        assert_eq!(updates[0]["id"], "renamed");
        assert_eq!(updates[0]["relativePath"], "Old.md");
        assert_eq!(media.reveal_path("renamed").unwrap(), root.join("Old.md"));
    }

    #[test]
    fn full_refresh_uses_visible_files_and_keeps_indexed_trash_readable() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let paths = [
            ("archived", "Archive/Archived.md"),
            ("trashed", ".kuskus/trash/trashed/Trashed.md"),
            ("hidden", ".obsidian/Hidden.md"),
            ("new", "New.md"),
        ];
        for (id, path) in paths {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, id).unwrap();
        }
        let items: Vec<_> = paths[..3]
            .iter()
            .map(|(id, path)| json!({"type": "note", "id": id, "relativePath": path, "body": "Cached"}))
            .collect();
        let snapshot = root.join(".kuskus/index/library-v1.json");
        let media = PreviewMedia::from_snapshot(&snapshot, &json!({"items": items})).unwrap();
        let updates = serde_json::to_value(media.refresh_text(None).unwrap()).unwrap();
        assert_eq!(updates.as_array().unwrap().len(), 3);
        assert_eq!(updates[0]["body"], "archived");
        assert_eq!(updates[1]["body"], "trashed");
        assert_eq!(updates[2]["missingContent"], true);
    }

    #[test]
    fn indexes_supported_previews_and_keeps_other_vault_items_revealable() {
        let snapshot = Path::new("vault/.kuskus/index/library-v1.json");
        let library = json!({"items": [
            {"id": "valid", "type": "file", "relativePath": "folder/report.PDF"},
            {"id": "media", "type": "file", "relativePath": "folder/other-report", "mediaType": "Application/PDF; version=1.7"},
            {"id": "escape", "type": "file", "relativePath": "../outside.pdf"},
            {"id": "absolute", "type": "file", "relativePath": "/outside.pdf"},
            {"id": "other", "type": "file", "relativePath": "folder/report.txt"},
            {"id": "image", "type": "image", "relativePath": "folder/photo.png", "mediaType": "image/png"},
            {"id": "svg", "type": "image", "relativePath": "folder/photo.svg", "mediaType": "image/svg+xml"},
            {"id": "image-escape", "type": "image", "relativePath": "../photo.png", "mediaType": "image/png"},
            {"id": "note", "type": "note", "relativePath": "folder/report.pdf"}
        ]});
        let media = PreviewMedia::from_snapshot(snapshot, &library).unwrap();
        assert_eq!(media.root, Path::new("vault"));
        assert_eq!(
            media
                .paths
                .into_iter()
                .filter_map(|(id, entry)| Some((id, (entry.relative_path, entry.media_type?))))
                .collect::<HashMap<_, _>>(),
            HashMap::from([
                (
                    "valid".to_owned(),
                    (PathBuf::from("folder/report.PDF"), "application/pdf")
                ),
                (
                    "media".to_owned(),
                    (PathBuf::from("folder/other-report"), "application/pdf")
                ),
                (
                    "image".to_owned(),
                    (PathBuf::from("folder/photo.png"), "image/png")
                ),
            ])
        );
        assert!(
            PreviewMedia::from_snapshot(Path::new("vault/library-v1.json"), &library).is_none()
        );
    }

    #[test]
    fn returns_original_webp_and_a_bounded_png_thumbnail() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/renderer/src/demo/assets/material-palette.webp");
        let original = read_preview(&path, "image/webp", false).unwrap();
        assert_eq!(original, std::fs::read(&path).unwrap());
        let thumbnail = read_preview(&path, "image/webp", true).unwrap();
        assert_eq!(image::guess_format(&thumbnail).unwrap(), ImageFormat::Png);
        let decoded = image::load_from_memory(&thumbnail).unwrap();
        assert_eq!(decoded.width(), THUMBNAIL_EDGE);
        assert_eq!(decoded.height(), 171);
        assert!(read_preview(&path, "image/jpeg", false).is_err());
    }

    #[test]
    fn serves_only_images_associated_with_the_requested_note() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        fs::create_dir(root.join("notes")).unwrap();
        let asset = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/renderer/src/demo/assets/material-palette.webp");
        let image = root.join("photo.webp");
        fs::copy(asset, &image).unwrap();
        let snapshot = root.join(".kuskus/index/library-v1.json");
        let library = json!({"items": [
            {
                "type": "note", "id": "note", "relativePath": "notes/Note.md",
                "attachments": [
                    {"id": "shared", "relativePath": "../photo.webp", "mediaType": "image/webp", "missingContent": false},
                    {"id": "escape", "relativePath": "../../photo.webp", "mediaType": "image/webp", "missingContent": false},
                    {"id": "missing", "relativePath": "../photo.webp", "mediaType": "image/webp", "missingContent": true}
                ]
            },
            {"type": "note", "id": "other", "relativePath": "Other.md", "attachments": []}
        ]});
        let media = PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        assert_eq!(
            media.read_attachment("note", "shared").unwrap(),
            fs::read(image).unwrap()
        );
        assert!(media.read_attachment("other", "shared").is_err());
        assert!(media.read_attachment("note", "escape").is_err());
        assert!(media.read_attachment("note", "missing").is_err());
    }

    #[test]
    fn restricts_native_open_to_images_and_reveals_known_items() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let asset = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/renderer/src/demo/assets/material-palette.webp");
        fs::copy(&asset, root.join("image.webp")).unwrap();
        fs::copy(asset, root.join("disguised.exe")).unwrap();
        fs::write(root.join("note.md"), "# Note").unwrap();
        let missing_id = "9c714697-69a0-4a2d-9a5a-1efa26258f52";
        let record = root
            .join(".kuskus/records")
            .join(format!("{missing_id}.json"));
        fs::create_dir_all(record.parent().unwrap()).unwrap();
        fs::write(&record, "{}").unwrap();
        let snapshot = root.join(".kuskus/index/library-v1.json");
        let library = json!({"items": [
            {"id": "image", "type": "image", "relativePath": "image.webp", "mediaType": "image/webp"},
            {"id": "disguised", "type": "image", "relativePath": "disguised.exe", "mediaType": "image/webp"},
            {"id": "note", "type": "note", "relativePath": "note.md"},
            {"id": missing_id, "type": "note", "relativePath": "missing.md"}
        ]});
        let media = PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        assert_eq!(
            media.image_open_path("image").unwrap(),
            root.join("image.webp")
        );
        assert!(media.image_open_path("disguised").is_err());
        assert!(media.image_open_path("note").is_err());
        assert_eq!(media.reveal_path("note").unwrap(), root.join("note.md"));
        assert_eq!(media.reveal_path(missing_id).unwrap(), record);
        assert!(media.reveal_path("unknown").is_err());
    }

    #[test]
    fn uses_only_current_bounded_thumbnail_cache_entries() {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let source = root.join("photo.webp");
        let asset = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/renderer/src/demo/assets/material-palette.webp");
        fs::copy(asset, &source).unwrap();
        let id = "b5897361-d50b-4100-bfb2-5e19f055d141";
        let snapshot = root.join(".kuskus/index/library-v1.json");
        let library = json!({"items": [{
            "id": id,
            "type": "image",
            "relativePath": "photo.webp",
            "mediaType": "image/webp",
            "updatedAt": "current",
            "width": 2172,
            "height": 724
        }]});
        let cache = root.join(".kuskus/thumbnails").join(id);
        fs::create_dir_all(&cache).unwrap();
        let manifest = cache.join("image-card.json");
        fs::write(&manifest, r#"{"sourceKey":"photo.webp:current:2172x724"}"#).unwrap();
        let image = cache.join("image-card.png");
        image::DynamicImage::new_rgb8(4, 2).save(&image).unwrap();
        let media = PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        assert_eq!(media.read(id, true).unwrap(), fs::read(&image).unwrap());
        fs::write(&manifest, r#"{"sourceKey":"photo.webp:stale:2172x724"}"#).unwrap();
        let regenerated = media.read(id, true).unwrap();
        assert_eq!(image::load_from_memory(&regenerated).unwrap().width(), 512);
    }
}
