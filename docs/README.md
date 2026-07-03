# Citadel docs

Citadel is a Tauri app that uses React for the UI and Rust for the backend.

Tauri uses native WebViews to render the UI, which is why the app is so small.
It also means that not all users will see the same UI, as it depends on the
browser engine installed on the user's system.

## 📚 Architecture Documentation

`ai-docs/` is point-in-time AI-generated analysis; it may not reflect the current code.

- **[Architecture Recommendations](../ai-docs/ARCHITECTURE_RECOMMENDATIONS.md)** - Detailed recommendations for Svelte-inspired React + Tauri/remote architecture
- **[Migration Example](../ai-docs/MIGRATION_EXAMPLE.md)** - Step-by-step guide for migrating the books feature to the new architecture
- **[Patterns Quick Reference](../ai-docs/PATTERNS_QUICK_REFERENCE.md)** - Cheat sheet of common patterns and best practices

## 🚀 Release & updater docs

- **[Updater and release operations](./updater-and-releases.md)** - Tauri updater setup, GitHub release flow, and verification checklist

**Start here if you're:**
- 🚀 **New to the project**: Read the Overview below, then [Architecture Recommendations](../ai-docs/ARCHITECTURE_RECOMMENDATIONS.md)
- 🔧 **Adding a feature**: Check [Patterns Quick Reference](../ai-docs/PATTERNS_QUICK_REFERENCE.md)
- 🏗️ **Planning refactoring**: Review [Architecture Summary](../ai-docs/ARCHITECTURE_SUMMARY.md) and [Migration Example](../ai-docs/MIGRATION_EXAMPLE.md)

## Overview

Citadel ships as a single bundled desktop app; a headless server & web app is exploratory only.

<figure>
  <img src="./assets/images/arch-overview.png" alt="Diagram showing that the UI has a Calibre client that uses IPC to talk to the backend's calibre adapter, which calls out to libcalibre. Space is left open to demonstrate that other clients and adapters are possible." />
  <figcaption>Overview of how the UI talks to <code>libcalibre</code>.</figcaption>
</figure>

The bundled app has a React frontend that uses interprocess communication (IPC) to send async commands to the backend.
The frontend has a `Library` that can be initialized to use different kind of library types.
For now, the only option is either local or remote Calibre libraries.

All reading, creating, and updating is done by the `libcalibre` crate.
Citadel is essentially a UI wrapper around that library.

## Principles

As little business logic is written in the front end as possible, excluding UI logic.

Where possible, we look to composability and modularity.
All logic related to Calibre, for instance, is in a `libcalibre` crate that can be used in other projects.

Modules are deep, and errors are defined out of existence. For more, see
[A Philosophy of Software Design](https://openlibrary.org/books/OL28736729M/A_Philosophy_of_Software_Design).

## Patterns

### Frontend

- Stores are a thin layer over the Tauri/remote backends; components subscribe
  to stores instead of calling commands directly.
- Book browsing is paged: the library store keeps a query cache
  (`src/lib/book-page-cache.ts`) with one entry per filter/sort combination —
  the total match count plus sparse 100-book pages fetched on demand and
  invalidated (by generation stamp) after mutations. Authors and the tag
  vocabulary are still loaded as full lists.
