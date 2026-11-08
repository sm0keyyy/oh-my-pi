import { isRecord } from "@oh-my-pi/web-render";
import type { ReactNode } from "react";
import { number, records, text, type Snapshot } from "./client";

export function UsageSection({ snapshot }: { snapshot: Snapshot }): ReactNode {
	const usage = snapshot.usage;
	return (
		<details className="rail-sec" open>
			<summary>Usage</summary>
			<div className="rail-body">
				{snapshot.usageError ? (
					<p role="alert">{snapshot.usageError}</p>
				) : usage === undefined ? (
					<p role="status">Loading usage…</p>
				) : !usage ? (
					<p>Usage unavailable. No CodexBar snapshot.</p>
				) : !Array.isArray(usage.providers) ? (
					<p role="alert">Invalid usage snapshot.</p>
				) : (
					<ul>
						{records(usage.providers).map(provider => (
							<li key={text(provider.id)}>
								{provider.unavailable === true ? (
									`${text(provider.label)} unavailable`
								) : (
									<>
										{text(provider.label)} {text(provider.plan)} ·{" "}
										{Array.isArray(provider.windows) &&
											provider.windows
												.filter(isRecord)
												.map(window => `${text(window.label)} ${number(window.usedPercent)}%`)
												.join(" · ")}
										{Array.isArray(provider.windows) &&
											provider.windows
												.filter(isRecord)
												.filter(window => typeof window.resetAt === "string")
												.sort((a, b) => Date.parse(text(a.resetAt)) - Date.parse(text(b.resetAt)))
												.slice(0, 1)
												.map(window => (
													<span key={text(window.kind)}>
														{" "}
														· resets {new Date(text(window.resetAt)).toLocaleString()}
													</span>
												))}
										{` · today ${typeof provider.todayTokens === "number" ? provider.todayTokens.toLocaleString() : "—"}`}
									</>
								)}
							</li>
						))}
					</ul>
				)}
				{usage && Array.isArray(usage.providers) && usage.providers.length === 0 && <p>No usage providers.</p>}
			</div>
		</details>
	);
}
