Query the project's codegraph index for source, symbols, call paths, and blast radius.

Use before grep for code structure: where is X, what calls X, and what an edit affects. Use grep for literal text.

- `explore`: query a concept or related symbols. Optional `maxFiles` caps source files.
- `node`: query a symbol or file. Use `file` to select file mode or disambiguate a symbol. Optional `offset` and `limit` select lines.
- `search`: query a symbol name.
- `callers`, `callees`, `impact`: query one symbol.
- `files`: list indexed files. No query required.

Worktrees query the canonical main checkout's index. This tool only queries. The codegraph-index extension owns index updates and query gates.
If the index is unavailable or a query returns nothing for a known symbol, use grep and continue.
