use std::process::ExitCode;

use citadel_server::Invocation;

#[tokio::main]
async fn main() -> ExitCode {
    return_large_blocks_to_the_os();
    let result = match citadel_server::invocation_from_args(std::env::args_os()) {
        Ok(Invocation::Version) => {
            println!("{}", citadel_server::release::describe());
            Ok(())
        }
        Ok(Invocation::Serve(source)) => match citadel_server::load(&source) {
            Ok(config) => citadel_server::run(config).await,
            Err(error) => Err(error),
        },
        Ok(Invocation::Health(source)) => match citadel_server::load(&source) {
            Ok(config) => citadel_server::health(&config).await,
            Err(error) => Err(error),
        },
        Ok(Invocation::Admin(source, args)) => citadel_server::load(&source)
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

/// Each Argon2 check allocates a 19 MiB buffer. Once glibc frees one large
/// mapped block it raises its mapping threshold past that size, so later
/// buffers land in the verifier thread's heap and stay resident after the
/// check. A fixed threshold maps every large block on its own and unmaps it
/// when freed, which costs microseconds against a 19 ms check.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn return_large_blocks_to_the_os() {
    const LARGE_BLOCK_BYTES: libc::c_int = 4 * 1024 * 1024;
    // SAFETY: mallopt only adjusts allocator tuning; it is called before
    // any large allocation and with a valid parameter.
    unsafe {
        libc::mallopt(libc::M_MMAP_THRESHOLD, LARGE_BLOCK_BYTES);
    }
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn return_large_blocks_to_the_os() {}
