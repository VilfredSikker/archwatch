use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
pub struct BranchDiff {
    pub base_branch: String,
    pub head_branch: String,
    pub files: Vec<DiffFile>,
    pub summary: DiffSummary,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffFile {
    pub path: String,
    pub status: FileStatus,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffSummary {
    pub files_changed: usize,
    pub additions: usize,
    pub deletions: usize,
    pub affected_modules: Vec<String>,
}

pub fn diff_against_branch(repo_path: &Path, base_branch: &str) -> anyhow::Result<BranchDiff> {
    let repo = git2::Repository::discover(repo_path)?;

    // Compute prefix to strip: watch_root relative to git repo root
    // e.g. if repo root is /project/ and watch_root is /project/src/, prefix = "src/"
    let watch_prefix = repo
        .workdir()
        .and_then(|wd| {
            let canonical_wd = wd.canonicalize().ok()?;
            let canonical_rp = repo_path.canonicalize().ok()?;
            canonical_rp.strip_prefix(&canonical_wd).ok().map(|p| p.to_path_buf())
        })
        .unwrap_or_default();

    let head_branch_name = repo
        .head()?
        .shorthand()
        .unwrap_or("HEAD")
        .to_string();

    let base_ref = repo
        .resolve_reference_from_short_name(base_branch)
        .map_err(|e| anyhow::anyhow!("Could not find branch '{}': {}", base_branch, e))?;
    let base_commit = base_ref.peel_to_commit()?;

    let base_tree = base_commit.tree()?;

    // Compare base branch tree against working directory (staged + unstaged).
    // This captures both committed branch differences and uncommitted work in one pass.
    let diff = repo.diff_tree_to_workdir_with_index(Some(&base_tree), None)?;

    let mut files: Vec<DiffFile> = Vec::new();
    let mut module_set = std::collections::HashSet::new();

    // First pass: collect file metadata
    diff.foreach(
        &mut |delta, _progress| {
            let (path, status) = match delta.status() {
                git2::Delta::Added => {
                    let p = delta
                        .new_file()
                        .path()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .into_owned();
                    (p, FileStatus::Added)
                }
                git2::Delta::Deleted => {
                    let p = delta
                        .old_file()
                        .path()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .into_owned();
                    (p, FileStatus::Deleted)
                }
                git2::Delta::Modified => {
                    let p = delta
                        .new_file()
                        .path()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .into_owned();
                    (p, FileStatus::Modified)
                }
                git2::Delta::Renamed => {
                    let p = delta
                        .new_file()
                        .path()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .into_owned();
                    (p, FileStatus::Renamed)
                }
                _ => {
                    let p = delta
                        .new_file()
                        .path()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .into_owned();
                    (p, FileStatus::Modified)
                }
            };

            // Strip watch_root prefix so paths are relative to the watched directory
            let path = Path::new(&path)
                .strip_prefix(&watch_prefix)
                .unwrap_or(Path::new(&path))
                .to_string_lossy()
                .into_owned();

            // Extract module (parent directory)
            if let Some(parent) = Path::new(&path).parent() {
                let module_path = parent.to_string_lossy().into_owned();
                if !module_path.is_empty() {
                    module_set.insert(module_path);
                }
            }

            files.push(DiffFile {
                path,
                status,
                additions: 0,
                deletions: 0,
            });
            true
        },
        None,
        None,
        None,
    )?;

    // Second pass: collect line stats per file index
    let mut file_index: usize = 0;
    let mut line_counts: Vec<(usize, usize)> = vec![(0, 0); files.len()];
    let mut total_additions = 0usize;
    let mut total_deletions = 0usize;

    diff.foreach(
        &mut |_delta, _progress| {
            file_index += 1;
            true
        },
        None,
        Some(&mut |_delta, _hunk| {
            true
        }),
        Some(&mut |delta, _hunk, line| {
            // Identify which file this line belongs to by matching path
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .unwrap_or(Path::new(""))
                .to_string_lossy()
                .into_owned();
            if let Some(idx) = files.iter().position(|f| f.path == path) {
                match line.origin() {
                    '+' => {
                        line_counts[idx].0 += 1;
                        total_additions += 1;
                    }
                    '-' => {
                        line_counts[idx].1 += 1;
                        total_deletions += 1;
                    }
                    _ => {}
                }
            }
            true
        }),
    )?;

    for (i, file) in files.iter_mut().enumerate() {
        file.additions = line_counts[i].0;
        file.deletions = line_counts[i].1;
    }

    let summary = DiffSummary {
        files_changed: files.len(),
        additions: total_additions,
        deletions: total_deletions,
        affected_modules: module_set.into_iter().collect(),
    };

    Ok(BranchDiff {
        base_branch: base_branch.to_string(),
        head_branch: head_branch_name,
        files,
        summary,
    })
}


