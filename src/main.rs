mod analyzer;
mod cli;
mod git_diff;
mod server;
mod watcher;

use clap::Parser;
use cli::Args;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();

    let path = args.path.canonicalize().unwrap_or(args.path.clone());

    eprintln!("Analyzing {}...", path.display());
    let graph = analyzer::analyze(&path, &args.flatten)?;
    eprintln!(
        "Found {} nodes, {} edges in {}ms",
        graph.nodes.len(),
        graph.edges.len(),
        graph.metadata.analysis_ms
    );

    let addr = format!("127.0.0.1:{}", args.port);
    let url = format!("http://{}", addr);

    if !args.no_open {
        let url_clone = url.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            let _ = open::that(url_clone);
        });
    }

    eprintln!("Server running at {}", url);
    server::serve(graph, &addr, path, args.flatten).await?;

    Ok(())
}


