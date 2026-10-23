//! Shield AI CLI binary entry point.

use std::process::ExitCode;

use clap::Parser;
use shield::cli::Cli;

fn main() -> ExitCode {
    let args = Cli::parse();
    match shield::cli::execute(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
