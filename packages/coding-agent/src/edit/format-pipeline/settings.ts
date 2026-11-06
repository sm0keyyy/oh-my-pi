import { register } from "../../config/registry";

export const cfgEditFormatPipeline = register({
	id: "edit.formatPipeline",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "Editing",
		label: "Format Pipeline",
		description: "Run project-configured prettier and markdownlint after edit and write",
	},
});

export const cfgEditAffectedTest = register({
	id: "edit.affectedTest",
	type: "boolean",
	default: true,
	ui: {
		tab: "files",
		group: "Editing",
		label: "Affected Test",
		description: "Run a unique same-basename sibling test as a detached advisory after edit and write",
	},
});
