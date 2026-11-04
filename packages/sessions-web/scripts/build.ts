import * as path from "node:path";
const result = await Bun.build({
	entrypoints: [path.resolve(import.meta.dir, "../index.html")],
	outdir: path.resolve(import.meta.dir, "../dist"),
	target: "browser",
	publicPath: "/",
	minify: true,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	naming: { entry: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
});
if (!result.success) throw new AggregateError(result.logs, "Sessions web build failed");
for (const output of result.outputs) {
	if (output.path.endsWith(".html")) await Bun.write(path.resolve(import.meta.dir, "../dist/index.html"), output);
}
await Bun.write(
	path.resolve(import.meta.dir, "../dist/react-virtuoso.LICENSE.txt"),
	Bun.file(new URL("../LICENSE", import.meta.resolve("react-virtuoso"))),
);
