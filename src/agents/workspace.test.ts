import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  loadWorkspaceBootstrapFiles,
  resolveDefaultAgentWorkspaceDir,
} from "./workspace.js";

describe("resolveDefaultAgentWorkspaceDir", () => {
  it("uses OPENCLAW_HOME for default workspace resolution", () => {
    const dir = resolveDefaultAgentWorkspaceDir({
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv);

    expect(dir).toBe(path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "workspace"));
  });
});

describe("loadWorkspaceBootstrapFiles", () => {
  it("ignores MEMORY.md and loads daily memory file if present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "should be ignored" });

    // Simulate today's memory file
    const today = new Date().toISOString().split("T")[0];
    const dailyFile = `memory/${today}.md`;
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await writeWorkspaceFile({ dir: tempDir, name: dailyFile, content: "daily logs" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);

    // MEMORY.md should NOT be in the loaded files as a standard bootstrap file
    // (WorkspaceBootstrapFileName type doesn't include it dynamically, so we check broadly)
    const longTermMemory = files.find((f) => f.name === "MEMORY.md");
    expect(longTermMemory).toBeUndefined();

    // Daily memory should be present
    const dailyMemory = files.find((f) => f.name === (dailyFile as any));
    expect(dailyMemory).toBeDefined();
    expect(dailyMemory?.content).toBe("daily logs");
  });

  it("loads nothing if daily memory is missing (ignoring MEMORY.md)", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "ignored" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);

    // Should filter out MEMORY.md and find no daily file
    const memoryFiles = files.filter((f) => f.name.includes("memory") || f.name === "MEMORY.md");
    expect(memoryFiles).toHaveLength(0);
  });
});
