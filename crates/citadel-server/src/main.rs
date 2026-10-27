use std::process::ExitCode;

use citadel_server::Invocation;

#[tokio::main]
async fn main() -> ExitCode {
    let result = match citadel_server::invocation_from_args(std::env::args_os()) {
        Ok(Invocation::Serve(path)) => match citadel_server::load_config(&path) {
            Ok(config) => citadel_server::run(config, &path).await,
            Err(error) => Err(error),
        },
        Ok(Invocation::Admin(path, args)) => citadel_server::load_config(&path)
            .and_then(|config| citadel_server::admin::run(&config, &args, std::io::stdin().lock()))
            .map(|output| println!("{output}")),
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
