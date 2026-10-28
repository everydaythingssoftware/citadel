import type { Meta, StoryObj } from "@storybook/react";
import type { DatabaseProblem } from "@/bindings";
import { DatabaseRecoveryCard } from "./DatabaseRecovery";

const problem = (overrides: Partial<DatabaseProblem>): DatabaseProblem => ({
	kind: "damaged",
	databasePath:
		"/Users/reader/Library/Application Support/software.everydaythings.citadel/citadel.db",
	details:
		"/Users/reader/Library/Application Support/software.everydaythings.citadel/citadel.db is not a readable Citadel database: file is not a database",
	backup: null,
	steps: ["startFresh", "quit"],
	...overrides,
});

const meta = {
	title: "Organisms/DatabaseRecovery",
	component: DatabaseRecoveryCard,
	args: {
		problem: problem({}),
		running: null,
		error: null,
		canReveal: true,
		onRecover: () => {},
		onReveal: () => {},
	},
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DatabaseRecoveryCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Damaged: Story = {};

export const NewerVersion: Story = {
	args: {
		problem: problem({
			kind: "newerVersion",
			details:
				"citadel.db was updated by a newer version of Citadel (migration 20261201000000). Update Citadel, or restore a citadel.db backup made by this version.",
			backup: {
				path: "/Users/reader/Library/Application Support/software.everydaythings.citadel/citadel.db.backup-20261028000000-1791820920",
				createdAt: "2026-10-12T15:42:00Z",
			},
			steps: ["update", "restoreBackup", "quit"],
		}),
	},
};

export const MigrationFailed: Story = {
	args: {
		problem: problem({
			kind: "migrationFailed",
			details:
				"citadel.db migration failed: UNIQUE constraint failed: users.username",
			steps: ["startFresh", "quit"],
		}),
	},
};

export const MigrationInterrupted: Story = {
	args: {
		problem: problem({
			kind: "migrationInterrupted",
			details:
				"citadel.db migration to 20261201000000 was interrupted 2 times.",
			steps: ["tryAgain", "startFresh", "quit"],
		}),
	},
};

export const Unreadable: Story = {
	args: {
		problem: problem({
			kind: "unreadable",
			details: "could not open citadel.db: permission denied",
			steps: ["quit"],
		}),
	},
};

export const Working: Story = { args: { running: "startFresh" } };

export const StepFailed: Story = {
	args: { error: "could not copy the backup: no space left on device" },
};
