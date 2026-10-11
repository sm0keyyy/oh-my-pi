import * as path from "node:path";
const result = await Bun.build({
	entrypoints: [path.resolve(import.meta.dir, "../index.html")],
	outdir: path.resolve(import.meta.dir, "../dist"),
	target: "browser",
	publicPath: "/",
	minify: true,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	naming: { entry: "[name].[ext]" },
});
if (!result.success) throw new AggregateError(result.logs, "Sessions web build failed");
