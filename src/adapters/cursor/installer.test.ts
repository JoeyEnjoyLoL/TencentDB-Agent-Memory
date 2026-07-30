import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURSOR_ADAPTER_MARKER,
  installCursorAdapter,
  uninstallCursorAdapter,
} from "./installer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor-installer-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(projectRoot)]);
  return { home, projectRoot };
}

async function readJson(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(file, "utf8"));
}

describe("Cursor Adapter installer", () => {
  // 用户级和项目级 Hook 会同时执行, 必须阻止跨作用域重复.
  it("另一作用域已有固定标识时拒绝安装", async () => {
    const { home, projectRoot } = await workspace();
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await writeFile(path.join(home, ".cursor", "hooks.json"), JSON.stringify({
      version: 1,
      hooks: {
        stop: [{ command: `existing ${CURSOR_ADAPTER_MARKER}` }],
      },
    }));

    await expect(installCursorAdapter({
      scope: "project",
      home,
      projectRoot,
      executablePath: "/bin/memory-tencentdb-cursor",
    })).rejects.toThrow(new RegExp(CURSOR_ADAPTER_MARKER));
  });

  // 同名 MCP 若非 Adapter 所有, 安装和卸载都不能覆盖或删除.
  it("拒绝覆盖同名非 Adapter MCP", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const cursorDir = path.join(options.projectRoot, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const original = {
      mcpServers: {
        "tencentdb-memory": { command: "user-owned-mcp", args: ["serve"] },
      },
    };
    await writeFile(mcpPath, JSON.stringify(original));

    await expect(installCursorAdapter(options)).rejects.toThrow(/MCP.*conflict/i);
    await uninstallCursorAdapter(options);

    expect(await readJson(mcpPath)).toEqual(original);
  });

  // 同名 Rule 无 marker 时属于用户文件, 不能覆盖.
  it("拒绝覆盖同名非 Adapter Rule", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const rulePath = path.join(
      options.projectRoot,
      ".cursor",
      "rules",
      "tencentdb-memory.mdc",
    );
    await mkdir(path.dirname(rulePath), { recursive: true });
    await writeFile(rulePath, "user rule");

    await expect(installCursorAdapter(options)).rejects.toThrow(/Rule.*conflict/i);

    expect(await readFile(rulePath, "utf8")).toBe("user rule");
  });

  // 已有事件字段不是数组时必须拒绝, 不能静默丢弃未知配置.
  it("拒绝覆盖非数组 Hook 事件配置", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const hooksPath = path.join(options.projectRoot, ".cursor", "hooks.json");
    await mkdir(path.dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, JSON.stringify({
      version: 1,
      hooks: { stop: { command: "custom-shape" } },
    }));

    await expect(installCursorAdapter(options)).rejects.toThrow(/Hook.*stop.*array/i);

    expect(await readJson(hooksPath)).toMatchObject({
      hooks: { stop: { command: "custom-shape" } },
    });
  });

  // 顶层 hooks 或 mcpServers 形态异常时也不能静默重置.
  it("拒绝覆盖异常顶层配置", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const cursorDir = path.join(options.projectRoot, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const hooksPath = path.join(cursorDir, "hooks.json");
    const mcpPath = path.join(cursorDir, "mcp.json");
    await writeFile(hooksPath, JSON.stringify({ version: 1, hooks: "custom" }));
    await writeFile(mcpPath, JSON.stringify({ mcpServers: [] }));

    await expect(installCursorAdapter(options)).rejects.toThrow(/hooks.*object/i);

    expect(await readJson(hooksPath)).toEqual({ version: 1, hooks: "custom" });
    expect(await readJson(mcpPath)).toEqual({ mcpServers: [] });

    await writeFile(hooksPath, JSON.stringify({ version: 1, hooks: {} }));
    await expect(installCursorAdapter(options)).rejects.toThrow(/mcpServers.*object/i);
    expect(await readJson(mcpPath)).toEqual({ mcpServers: [] });
  });

  // 安装只增加自己的 Hook MCP 和 Rule, 其他配置原样保留.
  it("安全合并项目级配置", async () => {
    const { home, projectRoot } = await workspace();
    const cursorDir = path.join(projectRoot, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(path.join(cursorDir, "hooks.json"), JSON.stringify({
      version: 1,
      custom: true,
      hooks: { stop: [{ command: "other-hook" }] },
    }));
    await writeFile(path.join(cursorDir, "mcp.json"), JSON.stringify({
      custom: true,
      mcpServers: { other: { command: "other-mcp" } },
    }));

    await installCursorAdapter({
      scope: "project",
      home,
      projectRoot,
      executablePath: "/bin/memory-tencentdb-cursor",
    });

    const hooks = await readJson(path.join(cursorDir, "hooks.json"));
    const mcp = await readJson(path.join(cursorDir, "mcp.json"));
    expect(hooks.custom).toBe(true);
    expect(hooks.hooks.stop).toContainEqual({ command: "other-hook" });
    expect(JSON.stringify(hooks)).toContain(CURSOR_ADAPTER_MARKER);
    expect(mcp).toMatchObject({
      custom: true,
      mcpServers: {
        other: { command: "other-mcp" },
        "tencentdb-memory": {
          command: "/bin/memory-tencentdb-cursor",
          args: ["mcp"],
        },
      },
    });
    expect(await readFile(
      path.join(cursorDir, "rules", "tencentdb-memory.mdc"),
      "utf8",
    )).toContain(CURSOR_ADAPTER_MARKER);
  });

  // 重复安装必须保持同一作用域 Hook 数量不变.
  it("同一作用域重复安装幂等", async () => {
    const options = {
      scope: "user" as const,
      ...await workspace(),
      executablePath: "/path with space/memory-tencentdb-cursor",
    };

    await installCursorAdapter(options);
    const first = await readFile(path.join(options.home, ".cursor", "hooks.json"), "utf8");
    await installCursorAdapter(options);
    const second = await readFile(path.join(options.home, ".cursor", "hooks.json"), "utf8");

    expect(second).toBe(first);
    expect(first).toContain("'/path with space/memory-tencentdb-cursor'");
  });

  // 卸载只删除 Adapter 自己的条目和 Rule.
  it("卸载保留其他工具配置", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    await installCursorAdapter(options);
    const cursorDir = path.join(options.projectRoot, ".cursor");
    const hooks = await readJson(path.join(cursorDir, "hooks.json"));
    hooks.hooks.stop.push({ command: "other-hook" });
    await writeFile(path.join(cursorDir, "hooks.json"), JSON.stringify(hooks));
    const mcp = await readJson(path.join(cursorDir, "mcp.json"));
    mcp.mcpServers.other = { command: "other-mcp" };
    await writeFile(path.join(cursorDir, "mcp.json"), JSON.stringify(mcp));

    await uninstallCursorAdapter(options);

    const afterHooks = await readJson(path.join(cursorDir, "hooks.json"));
    const afterMcp = await readJson(path.join(cursorDir, "mcp.json"));
    expect(JSON.stringify(afterHooks)).not.toContain(CURSOR_ADAPTER_MARKER);
    expect(afterHooks.hooks.stop).toEqual([{ command: "other-hook" }]);
    expect(afterMcp.mcpServers).toEqual({ other: { command: "other-mcp" } });
    await expect(readFile(
      path.join(cursorDir, "rules", "tencentdb-memory.mdc"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });
});
