//! Reconstruct the initial library from schema-v2 records when the disposable index is absent.
//! This is a read-only operation: visible files and recovery metadata are never rewritten.
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

use serde_json::{json, Value};

use crate::{
    preview_text::{is_youtube_video, parse_shortcut},
    preview_vault::{is_item_id, resolve_vault_directory, resolve_vault_file, same_path},
};

pub fn read_library(root: &Path, manifest: &Value) -> Result<Value, String> {
    for field in ["id", "name", "createdAt"] {
        require_string(manifest, field)?;
    }
    let mut collections = read_records(root, "collections")?;
    let records = read_records(root, "records")?;
    for collection in &mut collections {
        for field in ["name", "createdAt"] {
            require_string(collection, field)?;
        }
        if collection["icon"].is_null() {
            collection["icon"] = json!("folder");
        }
        if !collection["parentId"].is_null() && !collection["parentId"].is_string() {
            return Err("A collection record has an invalid parent ID.".into());
        }
        // Missing optional properties still need to be represented in the renderer DTO.
        collection["parentId"] = collection["parentId"].clone();
    }
    let mut items = records
        .iter()
        .map(|record| item_from_record(root, record, &collections))
        .collect::<Result<Vec<_>, _>>()?;
    items.sort_by(|left, right| right["createdAt"].as_str().cmp(&left["createdAt"].as_str()));
    Ok(json!({
        "schemaVersion": 2,
        "id": manifest["id"],
        "name": manifest["name"],
        "createdAt": manifest["createdAt"],
        "pinnedItemIds": manifest["pinnedItemIds"].as_array().cloned().unwrap_or_default(),
        "path": root.to_string_lossy(),
        "collections": collections,
        "items": items,
    }))
}

fn read_records(root: &Path, kind: &str) -> Result<Vec<Value>, String> {
    let directory = Path::new(".kuskus").join(kind);
    let directory = match resolve_vault_directory(root, &directory) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut entries = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort();
    let mut records: Vec<Value> = Vec::new();
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for entry in entries {
        if entry
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        let id = entry
            .file_stem()
            .and_then(|id| id.to_str())
            .unwrap_or_default();
        if !is_item_id(id) {
            return Err(format!("An invalid {kind} record needs repair."));
        }
        let path = resolve_vault_file(root, entry.strip_prefix(root).map_err(|e| e.to_string())?)
            .map_err(|error| error.to_string())?;
        let record: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|_| format!("The {kind} record {id} contains invalid JSON."))?;
        if record["schemaVersion"].as_u64() != Some(2) || record["id"].as_str() != Some(id) {
            return Err(format!(
                "The {kind} record {id} has an invalid identity or schema."
            ));
        }
        let relative = require_string(&record, "relativePath")?;
        validate_path(relative, kind == "records", id)?;
        let key: PathBuf = Path::new(relative).components().collect();
        #[cfg(windows)]
        let key = PathBuf::from(key.to_string_lossy().to_lowercase());
        if !ids.insert(id.to_ascii_lowercase()) || !paths.insert(key) {
            return Err(format!("Duplicate {kind} records need repair."));
        }
        records.push(record);
    }
    Ok(records)
}

fn validate_path(relative: &str, item: bool, id: &str) -> Result<(), String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains(['\\', ':', '\0'])
        || !path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || path
            .components()
            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
            && !(item
                && path.starts_with(Path::new(".kuskus/trash").join(id))
                && path
                    .components()
                    .skip(1)
                    .all(|part| !part.as_os_str().to_string_lossy().starts_with('.')))
    {
        return Err("A vault record contains an invalid relative path.".into());
    }
    Ok(())
}

fn require_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .ok_or_else(|| format!("A vault record has an invalid {field}."))
}

fn item_from_record(root: &Path, record: &Value, collections: &[Value]) -> Result<Value, String> {
    let metadata = &record["metadata"];
    if metadata["schemaVersion"].as_u64() != Some(2) || metadata["id"] != record["id"] {
        return Err("An item record has invalid metadata identity or schema.".into());
    }
    for field in ["title", "createdAt", "updatedAt", "type"] {
        require_string(metadata, field)?;
    }
    let relative = require_string(record, "relativePath")?;
    let path = Path::new(relative);
    let resolved = resolve_vault_file(root, path).ok();
    let mut item = metadata.clone();
    item["relativePath"] = json!(relative);
    item["location"] = location(path, metadata, collections);
    item["missingContent"] = json!(resolved.is_none());
    item["referencedAttachment"] =
        json!(metadata["referencedAttachment"].as_bool().unwrap_or(false));
    match require_string(metadata, "type")? {
        "note" => {
            let bytes = resolved.as_ref().and_then(|path| fs::read(path).ok());
            item["missingContent"] = json!(bytes.is_none());
            item["body"] = json!(bytes
                .as_deref()
                .map(String::from_utf8_lossy)
                .unwrap_or_default());
            item["bodyTruncated"] = json!(false);
            item["titleSource"] = json!(metadata["titleSource"].as_str().unwrap_or("derived"));
            item["referencedAttachment"] = json!(false);
            if !metadata["attachments"].is_null() && !metadata["attachments"].is_array() {
                return Err("A note record has invalid attachments.".into());
            }
            let mut attachments = metadata["attachments"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for attachment in &mut attachments {
                if !is_item_id(require_string(attachment, "id")?)
                    || attachment["width"].as_u64().is_none_or(|size| size == 0)
                    || attachment["height"].as_u64().is_none_or(|size| size == 0)
                {
                    return Err("A note record has invalid attachment metadata.".into());
                }
                require_string(attachment, "filename")?;
                require_string(attachment, "mediaType")?;
                let target = attachment_path(path, require_string(attachment, "relativePath")?)
                    .and_then(|relative| resolve_vault_file(root, &relative).ok());
                attachment["missingContent"] = json!(target.is_none());
            }
            item["attachments"] = json!(attachments);
        }
        "url" => {
            let source = resolved.as_ref().and_then(|path| fs::read(path).ok());
            let url = source
                .as_deref()
                .ok_or("The saved file is unavailable.")
                .and_then(|bytes| parse_shortcut(&String::from_utf8_lossy(bytes)));
            let same_url = url
                .as_ref()
                .is_ok_and(|url| metadata["sourceUrl"] == url.as_str());
            let (source_url, domain, video, error) = match url {
                Ok(url) => (
                    url.as_str().to_owned(),
                    url.host_str().unwrap_or_default().to_owned(),
                    is_youtube_video(&url),
                    None,
                ),
                Err(error) => (String::new(), String::new(), false, Some(error)),
            };
            item["sourceUrl"] = json!(source_url);
            item["domain"] = json!(domain);
            item["siteName"] = if same_url && metadata["siteName"].is_string() {
                metadata["siteName"].clone()
            } else {
                json!(domain)
            };
            item["contentKind"] = if same_url && metadata["contentKind"].is_string() {
                metadata["contentKind"].clone()
            } else {
                json!(if video { "video" } else { "webpage" })
            };
            item["metadataVersion"] = json!(metadata["metadataVersion"].as_u64().unwrap_or(1));
            item["hasFavicon"] = json!(false);
            item["hasPreviewImage"] = json!(false);
            if !same_url {
                item["description"] = Value::Null;
                item["metadataStatus"] = json!("unavailable");
                item["metadataError"] = json!(error);
            }
            item["referencedAttachment"] = json!(false);
        }
        "image" => {
            require_string(metadata, "mediaType")?;
            require_string(metadata, "contentFilename")?;
            if metadata["width"].as_u64().is_none_or(|width| width == 0)
                || metadata["height"].as_u64().is_none_or(|height| height == 0)
            {
                return Err("An image record has invalid dimensions.".into());
            }
            item["attachmentOrigin"] = metadata["attachmentOrigin"].clone();
        }
        "file" => {
            for field in ["mediaType", "contentFilename", "sourceFilename"] {
                require_string(metadata, field)?;
            }
            if metadata["size"].as_u64().is_none() {
                return Err("A file record has an invalid size.".into());
            }
        }
        _ => return Err("An item record has an unsupported type.".into()),
    }
    Ok(item)
}

fn location(path: &Path, metadata: &Value, collections: &[Value]) -> Value {
    if path.starts_with(".kuskus/trash") {
        return json!({"type": "trash", "trashedFrom": metadata["trashedFrom"].as_str().unwrap_or("inbox"), "originalCollectionId": metadata["originalCollectionId"]});
    }
    if path.starts_with("Archive") {
        return json!({"type": "archive", "originalCollectionId": metadata["originalCollectionId"]});
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    match collections.iter().find(|collection| {
        same_path(
            parent,
            Path::new(collection["relativePath"].as_str().unwrap()),
        )
    }) {
        Some(collection) => json!({"type": "collection", "collectionId": collection["id"]}),
        None => json!({"type": "inbox"}),
    }
}

fn attachment_path(note: &Path, reference: &str) -> Option<PathBuf> {
    let mut target = note.parent()?.to_owned();
    for component in Path::new(reference).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !target.pop() {
                    return None;
                }
            }
            Component::Normal(name) => target.push(name),
            _ => return None,
        }
    }
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preview_vault::read_vault;

    const NOTE: &str = "11111111-1111-4111-8111-111111111111";
    const FOLDER: &str = "22222222-2222-4222-8222-222222222222";
    const LINK: &str = "33333333-3333-4333-8333-333333333333";
    const IMAGE: &str = "44444444-4444-4444-8444-444444444444";
    const FILE: &str = "55555555-5555-4555-8555-555555555555";
    const DATE: &str = "2026-11-07T00:00:00.000Z";

    fn write(root: &Path, path: &str, bytes: impl AsRef<[u8]>) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn record(id: &str, kind: &str, path: &str) -> Value {
        json!({"schemaVersion": 2, "id": id, "relativePath": path,
            "metadata": {"schemaVersion": 2, "id": id, "type": kind,
            "title": "Saved title", "createdAt": DATE, "updatedAt": DATE,
            "originalCollectionId": null}})
    }

    fn fixture() -> tempfile::TempDir {
        let vault = tempfile::tempdir().unwrap();
        write(
            vault.path(),
            ".kuskus/library.json",
            json!({
                "schemaVersion": 2, "id": "vault", "name": "Records vault", "createdAt": DATE,
                "pinnedItemIds": [NOTE]
            })
            .to_string(),
        );
        write(
            vault.path(),
            &format!(".kuskus/collections/{FOLDER}.json"),
            json!({
                "schemaVersion": 2, "id": FOLDER, "relativePath": "Café", "name": "Café",
                "createdAt": DATE, "icon": "book", "parentId": null
            })
            .to_string(),
        );
        write(
            vault.path(),
            &format!(".kuskus/records/{NOTE}.json"),
            record(NOTE, "note", "Café/Résumé.md").to_string(),
        );
        write(
            vault.path(),
            "Café/Résumé.md",
            "---\naliases: [Résumé]\n---\n# Exact content\r\n☕ café\n",
        );
        vault
    }

    #[test]
    fn opens_records_without_index_and_ignores_corrupt_or_foreign_cache() {
        let vault = fixture();
        let root = vault.path();
        let original = fs::read(root.join("Café/Résumé.md")).unwrap();
        for cache in [
            None,
            Some("invalid json"),
            Some(
                r#"{"schemaVersion":1,"library":{"schemaVersion":2,"id":"other","items":[],"collections":[]}}"#,
            ),
        ] {
            if let Some(cache) = cache {
                write(root, ".kuskus/index/library-v1.json", cache);
            }
            let (index, library) = read_vault(root).unwrap();
            assert_eq!(
                index,
                root.canonicalize()
                    .unwrap()
                    .join(".kuskus/index/library-v1.json")
            );
            assert_eq!(library["items"].as_array().unwrap().len(), 1);
            let note = &library["items"][0];
            assert_eq!(note["id"], NOTE);
            assert_eq!(note["body"], String::from_utf8(original.clone()).unwrap());
            assert_eq!(note["missingContent"], false);
            assert_eq!(note["location"]["collectionId"], FOLDER);
            assert_eq!(library["collections"][0]["icon"], "book");
            assert_eq!(library["pinnedItemIds"], json!([NOTE]));
            assert_eq!(fs::read(root.join("Café/Résumé.md")).unwrap(), original);
            if let Some(cache) = cache {
                assert_eq!(fs::read_to_string(&index).unwrap(), cache);
            } else {
                assert!(!index.exists());
            }
        }
    }

    #[test]
    fn reads_bookmarks_media_missing_content_and_lifecycle_locations() {
        let vault = fixture();
        let root = vault.path();
        let mut link = record(LINK, "url", "Archive/Watch.url");
        link["metadata"]["sourceUrl"] = json!("https://old.example/");
        link["metadata"]["description"] = json!("Stale description");
        write(
            root,
            &format!(".kuskus/records/{LINK}.json"),
            link.to_string(),
        );
        write(
            root,
            "Archive/Watch.url",
            "[InternetShortcut]\nURL=https://www.youtube.com/watch?v=abcdefghijk\n",
        );
        let mut image = record(IMAGE, "image", "Café/Sketch.png");
        image["metadata"]["mediaType"] = json!("image/png");
        image["metadata"]["contentFilename"] = json!("Sketch.png");
        image["metadata"]["width"] = json!(12);
        image["metadata"]["height"] = json!(10);
        write(
            root,
            &format!(".kuskus/records/{IMAGE}.json"),
            image.to_string(),
        );
        let mut file = record(FILE, "file", &format!(".kuskus/trash/{FILE}/Report.pdf"));
        file["metadata"]["mediaType"] = json!("application/pdf");
        file["metadata"]["sourceFilename"] = json!("Report.pdf");
        file["metadata"]["contentFilename"] = json!("Report.pdf");
        file["metadata"]["size"] = json!(5);
        file["metadata"]["trashedFrom"] = json!("collection");
        file["metadata"]["originalCollectionId"] = json!(FOLDER);
        write(
            root,
            &format!(".kuskus/records/{FILE}.json"),
            file.to_string(),
        );
        write(root, file["relativePath"].as_str().unwrap(), "%PDF-");
        let (_, library) = read_vault(root).unwrap();
        let find = |id| {
            library["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == id)
                .unwrap()
        };
        assert_eq!(find(LINK)["contentKind"], "video");
        assert_eq!(find(LINK)["description"], Value::Null);
        assert_eq!(find(LINK)["location"]["type"], "archive");
        assert_eq!(find(IMAGE)["missingContent"], true);
        assert_eq!(find(FILE)["missingContent"], false);
        assert_eq!(find(FILE)["location"]["trashedFrom"], "collection");
        write(
            root,
            "Archive/Watch.url",
            "[InternetShortcut]\nURL=file:///secret\n",
        );
        let (_, library) = read_vault(root).unwrap();
        let link = library["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == LINK)
            .unwrap();
        assert_eq!(link["sourceUrl"], "");
        assert!(link["metadataError"].is_string());
        fs::remove_file(root.join("Café/Résumé.md")).unwrap();
        let (_, library) = read_vault(root).unwrap();
        let note = library["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == NOTE)
            .unwrap();
        assert_eq!(note["body"], "");
        assert_eq!(note["missingContent"], true);
    }

    #[test]
    fn rejects_ambiguous_invalid_or_escaping_records_without_modifying_them() {
        let vault = fixture();
        let root = vault.path();
        let record_path = format!(".kuskus/records/{LINK}.json");
        for relative in [
            "../outside.md",
            "/absolute.md",
            "Café/Résumé.md",
            ".obsidian/secret.md",
            ".kuskus/library.json",
            "Café/Note.md:stream",
            ".kuskus/trash/other/secret.md",
        ] {
            let bytes = record(LINK, "note", relative).to_string();
            write(root, &record_path, &bytes);
            assert!(read_vault(root).is_err(), "{relative}");
            assert_eq!(fs::read_to_string(root.join(&record_path)).unwrap(), bytes);
        }
        for value in [
            json!({"schemaVersion": 3}),
            json!({"schemaVersion": 2, "id": LINK, "relativePath": "Second.md", "metadata": {"schemaVersion": 2, "id": NOTE}}),
        ] {
            write(root, &record_path, value.to_string());
            assert!(read_vault(root).is_err());
        }
        write(root, &record_path, "{");
        assert!(read_vault(root).is_err());
    }

    #[test]
    fn reconstructs_saved_attachment_access_without_an_index_directory() {
        let vault = fixture();
        let root = vault.path();
        let mut note = record(NOTE, "note", "Café/Résumé.md");
        let attachment = json!({"id": IMAGE, "filename": "Sketch.png", "relativePath": "../Sketch.png",
            "sourceFilename": "Sketch.png", "mediaType": "image/png", "width": 2, "height": 2});
        note["metadata"]["attachments"] = json!([attachment]);
        write(
            root,
            &format!(".kuskus/records/{NOTE}.json"),
            note.to_string(),
        );
        write(root, "Café/Résumé.md", "![Sketch](../Sketch.png)");
        image::RgbaImage::new(2, 2)
            .save(root.join("Sketch.png"))
            .unwrap();
        let expected = fs::read(root.join("Sketch.png")).unwrap();
        let (snapshot, library) = read_vault(root).unwrap();
        assert_eq!(
            library["items"][0]["attachments"][0]["missingContent"],
            false
        );
        let media = crate::preview_media::PreviewMedia::from_snapshot(&snapshot, &library).unwrap();
        assert_eq!(media.read_attachment(NOTE, IMAGE).unwrap(), expected);
        fs::remove_file(root.join("Sketch.png")).unwrap();
        let (_, library) = read_vault(root).unwrap();
        assert_eq!(library["items"][0]["attachments"][0]["id"], IMAGE);
        assert_eq!(
            library["items"][0]["attachments"][0]["missingContent"],
            true
        );
    }

    #[test]
    fn does_not_follow_linked_record_directories() {
        let vault = fixture();
        let external = tempfile::tempdir().unwrap();
        let directory = vault.path().join(".kuskus").join("records");
        fs::rename(&directory, vault.path().join(".kuskus/original-records")).unwrap();
        #[cfg(windows)]
        {
            // Directory junctions do not require Windows symlink privileges.
            let result = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&directory)
                .arg(external.path())
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{} {}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(external.path(), &directory).unwrap();
        assert!(read_vault(vault.path()).is_err());
        assert_eq!(fs::read_dir(external.path()).unwrap().count(), 0);
    }
}
