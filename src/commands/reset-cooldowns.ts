import type { ProfileUsageStats, ModelUsageStats } from "../agents/auth-profiles/types.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { loadAuthProfileStore, saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { theme } from "../terminal/theme.js";

export type ResetCooldownsOptions = {
  /**
   * Provider to reset cooldowns for (e.g., "openrouter", "google-antigravity").
   * If not provided, all providers are cleared.
   */
  provider?: string;
  /**
   * Only show what would be changed without actually resetting.
   */
  dryRun?: boolean;
  /**
   * Output in JSON format.
   */
  json?: boolean;
};

type CooldownStats = {
  provider: string;
  profileId: string;
  profileLevel: {
    errorCount?: number;
    cooldownUntil?: number;
    disabledUntil?: number;
    disabledReason?: string;
  };
  modelStats: Record<
    string,
    {
      errorCount?: number;
      cooldownUntil?: number;
    }
  >;
};

export async function resetCooldownsCommand(options: ResetCooldownsOptions = {}): Promise<void> {
  const { provider, dryRun, json } = options;
  const agentDir = resolveOpenClawAgentDir();
  const authPath = resolveAuthStorePath(agentDir);

  const store = loadAuthProfileStore();

  const usageStats = store.usageStats ?? {};
  const profileIds = Object.keys(usageStats);

  if (profileIds.length === 0) {
    if (json) {
      console.log(JSON.stringify({ success: true, message: "No usage stats to clear" }));
    } else {
      console.log(theme.success("✓"), "No usage stats to clear");
    }
    return;
  }

  // Collect stats before clearing
  const statsBefore: CooldownStats[] = [];
  for (const profileId of profileIds) {
    const [profileProvider] = profileId.split(":");
    if (provider && profileProvider !== provider) {
      continue;
    }

    const stats = usageStats[profileId] as ProfileUsageStats | undefined;
    if (!stats) {
      continue;
    }

    const modelStatsMap: CooldownStats["modelStats"] = {};
    if (stats.modelStats) {
      for (const [modelId, modelStatRaw] of Object.entries(stats.modelStats)) {
        const modelStat = modelStatRaw;
        if (modelStat.errorCount || modelStat.cooldownUntil) {
          modelStatsMap[modelId] = {
            errorCount: modelStat.errorCount,
            cooldownUntil: modelStat.cooldownUntil,
          };
        }
      }
    }

    statsBefore.push({
      provider: profileProvider,
      profileId,
      profileLevel: {
        errorCount: stats.errorCount,
        cooldownUntil: stats.cooldownUntil,
        disabledUntil: stats.disabledUntil,
        disabledReason: stats.disabledReason,
      },
      modelStats: modelStatsMap,
    });
  }

  if (statsBefore.length === 0) {
    if (json) {
      console.log(
        JSON.stringify({
          success: true,
          message: provider ? `No cooldowns found for provider: ${provider}` : "No cooldowns found",
        }),
      );
    } else {
      console.log(
        theme.success("✓"),
        provider ? `No cooldowns found for provider: ${provider}` : "No cooldowns found",
      );
    }
    return;
  }

  if (dryRun) {
    if (json) {
      console.log(JSON.stringify({ dryRun: true, wouldClear: statsBefore }, null, 2));
    } else {
      console.log(theme.heading("Dry run - would clear the following cooldowns:\n"));
      for (const entry of statsBefore) {
        console.log(theme.accent(`${entry.profileId}:`));
        if (
          entry.profileLevel.errorCount ||
          entry.profileLevel.cooldownUntil ||
          entry.profileLevel.disabledUntil
        ) {
          console.log(`  Profile-level:`);
          if (entry.profileLevel.errorCount) {
            console.log(`    errorCount: ${entry.profileLevel.errorCount}`);
          }
          if (entry.profileLevel.cooldownUntil) {
            console.log(
              `    cooldownUntil: ${new Date(entry.profileLevel.cooldownUntil).toISOString()}`,
            );
          }
          if (entry.profileLevel.disabledUntil) {
            console.log(
              `    disabledUntil: ${new Date(entry.profileLevel.disabledUntil).toISOString()} (${entry.profileLevel.disabledReason})`,
            );
          }
        }
        const modelIds = Object.keys(entry.modelStats);
        if (modelIds.length > 0) {
          console.log(`  Model-level:`);
          for (const modelId of modelIds) {
            const ms = entry.modelStats[modelId];
            console.log(
              `    ${modelId}: errorCount=${ms.errorCount ?? 0}, cooldownUntil=${ms.cooldownUntil ? new Date(ms.cooldownUntil).toISOString() : "none"}`,
            );
          }
        }
        console.log();
      }
    }
    return;
  }

  // Actually clear the cooldowns
  for (const profileId of profileIds) {
    const [profileProvider] = profileId.split(":");
    if (provider && profileProvider !== provider) {
      continue;
    }

    const stats = usageStats[profileId] as ProfileUsageStats | undefined;
    if (!stats) {
      continue;
    }

    // Clear profile-level cooldowns
    delete stats.errorCount;
    delete stats.cooldownUntil;
    delete stats.disabledUntil;
    delete stats.disabledReason;
    delete stats.failureCounts;
    delete stats.lastFailureAt;

    // Clear model-level cooldowns
    if (stats.modelStats) {
      for (const modelId of Object.keys(stats.modelStats)) {
        delete stats.modelStats[modelId];
      }
      delete stats.modelStats;
    }
  }

  saveAuthProfileStore(store, agentDir);

  if (json) {
    console.log(JSON.stringify({ success: true, cleared: statsBefore }, null, 2));
  } else {
    console.log(theme.success("✓"), `Cleared cooldowns for ${statsBefore.length} profile(s):`);
    for (const entry of statsBefore) {
      console.log(`  - ${entry.profileId}`);
    }
    console.log();
    console.log(theme.muted("Auth profile store updated at:"), authPath);
  }
}
