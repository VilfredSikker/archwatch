use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;

const SKIP_DIRS: &[&str] = &[
    ".git", "target", "node_modules", "dist", ".next", "build",
];
const WATCH_EXTS: &[&str] = &["rs", "ts", "tsx", "js"];

pub fn watch(root: PathBuf) -> mpsc::Receiver<Vec<PathBuf>> {
    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>(32);

    std::thread::spawn(move || {
        let (sync_tx, sync_rx) = std::sync::mpsc::channel::<DebounceEventResult>();

        let mut debouncer = match new_debouncer(Duration::from_millis(300), sync_tx) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("watcher: failed to create debouncer: {e}");
                return;
            }
        };

        if let Err(e) = debouncer.watcher().watch(&root, RecursiveMode::Recursive) {
            eprintln!("watcher: failed to watch {}: {e}", root.display());
            return;
        }

        for result in sync_rx {
            match result {
                Ok(events) => {
                    let paths: Vec<PathBuf> = events
                        .into_iter()
                        .map(|e| e.path)
                        .filter(|p| is_relevant(p))
                        .collect();

                    if !paths.is_empty() {
                        let _ = tx.blocking_send(paths);
                    }
                }
                Err(e) => {
                    eprintln!("watcher error: {e}");
                }
            }
        }
    });

    rx
}

fn is_relevant(path: &Path) -> bool {
    let has_watched_ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| WATCH_EXTS.contains(&e))
        .unwrap_or(false);

    if !has_watched_ext {
        return false;
    }

    !path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| SKIP_DIRS.contains(&s))
            .unwrap_or(false)
    })
}




