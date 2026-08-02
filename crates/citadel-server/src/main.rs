use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let result = match citadel_server::config_path_from_args(std::env::args_os())
        .and_then(|path| citadel_server::load_config(&path))
    {
        Ok(config) => citadel_server::run(config).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("citadel_server error={error}");
            ExitCode::FAILURE
        }
    }
}
