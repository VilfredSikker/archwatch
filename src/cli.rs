use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "aw", version, about = "Live architecture diagrams")]
pub struct Args {
    /// Path to the repository to analyze (default: current directory)
    #[arg(default_value = ".")]
    pub path: PathBuf,

    /// Port for the local server
    #[arg(long, default_value_t = 3838)]
    pub port: u16,

    /// Don't open browser automatically
    #[arg(long)]
    pub no_open: bool,

    /// Flatten these directories (remove as nodes, promote children).
    /// Comma-separated, e.g. --flatten src,app
    #[arg(long, value_delimiter = ',')]
    pub flatten: Vec<String>,
}


