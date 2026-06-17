/**
 * Switches Pi's active model before skill commands expand.
 *
 * Skill frontmatter does not support a native model field, so this extension
 * maps `/skill:<name>` invocations to a model and then lets Pi continue with
 * normal skill expansion.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SkillModelTarget {
  provider: string;
  model: string;
}

const skillModels: Record<string, SkillModelTarget> = {
  "default-model": {
    provider: "openai-codex",
    model: "gpt-5.5",
  },
  "commit-name": {
    provider: "openai-codex",
    model: "gpt-5.4-mini",
  },
};

function parseSkillCommand(text: string): string | undefined {
  const match = text.trimStart().match(/^\/skill:([^\s]+)/);
  return match?.[1];
}

export default function(pi: ExtensionAPI) {
  let routedSkillName: string | undefined;

  async function switchModel(
    skillName: string,
    target: SkillModelTarget,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    if (ctx.model?.provider === target.provider && ctx.model?.id === target.model) {
      return true;
    }

    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model) {
      ctx.ui.notify(
        `Skill "${skillName}": model ${target.provider}/${target.model} was not found`,
        "warning",
      );
      return false;
    }

    const success = await pi.setModel(model);
    if (!success) {
      ctx.ui.notify(
        `Skill "${skillName}": no API key is available for ${target.provider}/${target.model}`,
        "warning",
      );
      return false;
    }

    return true;
  }

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" };
    }

    const skillName = parseSkillCommand(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    const target = skillModels[skillName];
    if (!target) {
      return { action: "continue" };
    }

    const success = await switchModel(skillName, target, ctx);
    if (success) {
      routedSkillName = skillName;
      ctx.ui.notify(`Skill "${skillName}" switched model to ${target.provider}/${target.model}`, "info");
    }

    return { action: "continue" };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!routedSkillName) {
      return;
    }

    const skillName = routedSkillName;
    routedSkillName = undefined;

    const success = await switchModel(skillName, skillModels["default-model"], ctx);
    if (success) {
      ctx.ui.notify(
        `Skill "${skillName}" finished; switched model back to ${skillModels["default-model"].provider}/${skillModels["default-model"].model}`,
        "info",
      );
    }
  });
}
