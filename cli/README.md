# Shield CLI (`shield`)

Rust CLI for Shield AI — see `../docs/PLAN_V2.md` §7.2 and §8 for the
specification this crate implements.

## Commands (exactly three)

```sh
shield login           # device flow: prints a verification URL + user code,
                       # polls until approved, stores the CLI token
shield scan [path]     # snapshot a project (default "."), preview the Shield
                       # cost, confirm, upload, and report the server status
shield scan --auto     # same, skipping only the confirmation prompt
shield logout          # revoke the token server-side (best effort) and
                       # delete local credentials
```

The API base URL comes from `SHIELD_API_URL` (default
`http://localhost:3000`).

## Behavior highlights

- File discovery is gitignore-aware (`ignore` crate); `node_modules`,
  `.git`, `target`, `dist`, `build`, `.next`, and `vendor` are always
  excluded; symlinks are never followed out of the scan root.
- `.env*` files are **always** excluded, gitignore or not.
- Text vs binary is decided by content (NUL byte in the first 8 KB or
  invalid UTF-8), never by extension.
- Files are read once into an in-memory snapshot; uploads send the
  captured bytes (SHA-256 addressed), with bounded per-file retries,
  and analysis starts only after the server's completion step accepts
  every file.
- Full-scan cost is computed locally from the PLAN_V2 §3 tiers
  (≤100 files and ≤500 KB → 5 Shields; ≤300 files and ≤2 MB → 12);
  anything larger is a hard "snapshot too large" error.
- Credentials live in the OS keyring when available, falling back to
  `~/.config/shield/credentials.json` (0600) with a printed warning.
  The token is never printed.

## Develop

```sh
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test   # includes a mock-server (std TcpListener) integration suite
```
