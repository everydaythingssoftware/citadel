# Citadel

[![Quality checks](https://github.com/everydaythingssoftware/citadel/actions/workflows/quality.yml/badge.svg)](https://github.com/everydaythingssoftware/citadel/actions/workflows/quality.yml)
[![Build](https://github.com/everydaythingssoftware/citadel/actions/workflows/build.yml/badge.svg)](https://github.com/everydaythingssoftware/citadel/actions/workflows/build.yml)
[![](https://dcbadge.limes.pink/api/server/Hh6gRmqBbC?style=flat)](https://discord.gg/Hh6gRmqBbC)

Manage your ebook library with Citadel. Backwards compatible with Calibre.

https://github.com/user-attachments/assets/7db593a9-2095-4ac9-8f38-45107cc059dd

## Project goals

- **Backwards compatible with Calibre**: Calibre must be able to read any library that Citadel has edited.
- **Good UX**: Citadel must be easy to use and look good.
- **Performant**: Citadel must feel much faster than Calibre, and never slower.

### Non-goals

- **Ebook reader**: Citadel is not an ebook reader. There are already excellent ereader apps: Citadel will open your files in your default apps.
- **...or editor**: If you're editing ebook *content* (not metadata like titles), Citadel will not be a replacement for you.
- **100% feature parity**: Primarily around Plugins, but there are some advanced features of Calibre we'll likely never build.

## Downloading

Stable builds are available in [Releases](https://github.com/everydaythingssoftware/citadel/releases).

Development builds are available from [GitHub actions](https://github.com/everydaythingssoftware/citadel/actions/workflows/build.yml).

Please report any issues or crashes you experience while using any version of Citadel!

### Installing on macOS

Download the `.dmg` from [Releases](https://github.com/everydaythingssoftware/citadel/releases), drag Citadel to Applications, and open it.

> [!NOTE]
>
> Development builds from [GitHub Actions](https://github.com/everydaythingssoftware/citadel/actions/workflows/build.yml) are *not* signed. macOS will report those as "damaged"; [removing the quarantine attribute](https://superuser.com/questions/526920/how-to-remove-quarantine-from-file-permissions-in-os-x) resolves this:
>
> ```fish
> xattr -d com.apple.quarantine /Applications/Citadel.app/
> ```

## Developing

As a prerequisite, you'll need to install [Bun](https://bun.sh) and [Rust](https://www.rust-lang.org/tools/install).

Then, you can install the packages.

```fish
bun install
```

and start up the app like so:

```fish
bun run dev
# or just bun dev
```

### Lint &amp; Formatting

To lint all source code, run `bun lint`. To autoformat, run `bun format`.


| Scope    | Action         | Command              |
| -------- | -------------- | -------------------- |
| All code | Format         | `bun format`         |
| All code | Format (Check) | `bun format:check`   |
| All code | Lint           | `bun lint`           |
| Backend  | Format         | `bun format:backend` |
| Backend  | Lint           | `bun lint:backend`   |
| Frontend | Format         | `bun format:web`     |
| Frontend | Lint           | `bun lint:web`       |


### App preview without backend

You can run just the frontend with this command, although you WILL see errors as the Rust backend will be missing but is assumed to exist:

```fish
bun dev:app
```

## Building

To create a production version of Citadel, you'll need the development prereqs. Then:

```bash
bun install
bun run build
```

### Auto-updater and releases

Citadel can check for app updates and install them on request. Automatic update checks can be disabled in Settings (`Auto updates: On/Off`), and installs are always explicit (`Install and restart`). For maintainer setup and release workflow details, see [`docs/updater-and-releases.md`](docs/updater-and-releases.md).

## Additional Credit &amp; Related Projects

This project would not be possible without the north star created by Kovid Goyal, [Calibre](https://github.com/kovidgoyal/calibre). Without his hard work building such an extensive and powerful tool, Citadel would not exist.

Huge thanks to [Kemie Guaida](https://kemielikes.design/), who created an excellent [Calibre redesign Figma prototype](https://old.reddit.com/r/Calibre/comments/udzumn/testing_a_new_interface_for_calibre/), from which Citadel takes inspiration. Thank you, Kemie!