import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { lookup, Setting } from "../config/registry";
import type { Settings } from "../config/settings";

export interface BeadsRoute {
	root: string;
	kind: "repo" | "global";
	prefix: string;
}
const storeSetting = new Setting<string>({
	id: "todo.store",
	type: "enum",
	values: ["beads", "session"],
	default: "beads",
});
const rootsSetting = new Setting<readonly string[]>({
	id: "todo.beads.roots",
	type: "array",
	default: ["~/Developer"],
});
const globalSetting = new Setting<string>({ id: "todo.beads.globalDir", type: "string", default: "~/.omp/beads" });
export function beadsSettings(settings: Settings): {
	store: unknown;
	roots: readonly string[];
	globalDir: string;
	explicitRoots: boolean;
} {
	return {
		store: (lookup(storeSetting.id) ?? storeSetting).get(settings),
		roots: rootsSetting.get(settings),
		globalDir: globalSetting.get(settings),
		explicitRoots: settings.isConfigured(rootsSetting),
	};
}
export function expandBeadsPath(value: string): string {
	return path.resolve(
		value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value,
	);
}
export function routeBeadsStore(cwd: string, roots: readonly string[], globalDir: string): BeadsRoute {
	const info = vcs.gitInfo(cwd);
	const primary = info
		? path.basename(info.commonDir) === ".git"
			? path.dirname(info.commonDir)
			: info.gitDir === info.commonDir
				? info.repoRoot
				: undefined
		: undefined;
	if (primary) {
		const root = fs.realpathSync(primary);
		if (
			roots.some(entry => {
				const configured = expandBeadsPath(entry);
				const relative = path.relative(fs.existsSync(configured) ? fs.realpathSync(configured) : configured, root);
				return (
					relative === "" ||
					(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
				);
			})
		) {
			const base = path.basename(root) === "repo" ? path.basename(path.dirname(root)) : path.basename(root);
			return { root, kind: "repo", prefix: base.toLowerCase().replace(/[^a-z0-9-]/g, "") || "omp" };
		}
	}
	return { root: expandBeadsPath(globalDir), kind: "global", prefix: "global" };
}
