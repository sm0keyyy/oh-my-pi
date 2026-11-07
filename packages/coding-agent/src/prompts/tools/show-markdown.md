Open a markdown file for operator comments in a Rex pane. Parameters: path (a .md file or local:// URL, at most 1 MiB), title (optional).

Returns after the pane opens, without waiting for comments. The operator adds section comments with c, then submits the batch with s. One message returns to the agent that opened the view. Closing the view delivers nothing; unsent comments require discard confirmation. This does not ask for approval. Without a Rex pane host, the view is not opened.
