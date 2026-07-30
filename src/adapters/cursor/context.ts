import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  generateSceneNavigation,
  stripSceneNavigation,
} from "../../core/scene/scene-navigation.js";
import { readSceneIndex } from "../../core/scene/scene-index.js";
import { escapeXmlTags } from "../../utils/sanitize.js";

const TOOL_GUIDE = `任务依赖历史偏好、既往决策或项目经验时, 先调用 tdai_memory_search.
需要原话、时间线或证据时, 再调用 tdai_conversation_search.
命中场景导航后, 按绝对路径读取正文.
自包含任务不主动检索.
不要调用 tdai_capture 或 tdai_session_end.`;

export async function buildSessionContext(
  dataDir: string,
): Promise<string | undefined> {
  const parts: string[] = [];

  try {
    const raw = await readFile(path.join(dataDir, "persona.md"), "utf8");
    const persona = escapeXmlTags(stripSceneNavigation(raw).trim());
    if (persona) {
      parts.push(`<user-persona>\n${persona}\n</user-persona>`);
    }
  } catch {
    // 新用户没有 Persona 是正常状态.
  }

  const scenes = (await readSceneIndex(dataDir)).filter(
    (scene) =>
      path.basename(scene.filename) === scene.filename &&
      scene.filename.endsWith(".md"),
  );
  const navigation = escapeXmlTags(
    generateSceneNavigation(scenes, path.resolve(dataDir)),
  );
  if (navigation) {
    parts.push(`<scene-navigation>\n${navigation}\n</scene-navigation>`);
  }

  parts.push(`<memory-tools>\n${TOOL_GUIDE}\n</memory-tools>`);
  return parts.join("\n\n") || undefined;
}
