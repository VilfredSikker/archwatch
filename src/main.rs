mod analyzer;
mod cli;
mod git_diff;
mod server;
mod watcher;

use clap::Parser;
use cli::Args;
use tokio::net::TcpListener;

async fn bind_available_port(preferred: u16) -> anyhow::Result<TcpListener> {
    for port in preferred..=preferred.saturating_add(10) {
        match TcpListener::bind(format!("127.0.0.1:{}", port)).await {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("No available port found in range {}–{}", preferred, preferred.saturating_add(10))
}

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

    let listener = bind_available_port(args.port).await?;
    let actual_port = listener.local_addr()?.port();
    let url = format!("http://127.0.0.1:{}", actual_port);

    if actual_port != args.port {
        eprintln!("Port {} in use, using {} instead", args.port, actual_port);
    }

    if !args.no_open {
        let url_clone = url.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            let _ = open::that(url_clone);
        });
    }

    eprintln!("Server running at {}", url);
    server::serve(graph, listener, path, args.flatten).await?;

    Ok(())
}


