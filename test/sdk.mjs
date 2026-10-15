import { readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve from the actual host, without installing another SDK or changing it.
const root = process.env.PI_D_ROOT ?? resolve(fileURLToPath(new URL("../../pi-d/", import.meta.url)));
async function hostImport(name) {
  const packageName = name.split("/").slice(0, 2).join("/");
  for (let directory = root;; directory = dirname(directory)) {
    const manifestPath = join(directory, "node_modules", packageName, "package.json");
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (manifest) {
      const key = name === packageName ? "." : `.${name.slice(packageName.length)}`;
      let target = manifest.exports[key];
      if (!target) {
        const pattern = Object.keys(manifest.exports).find((item) => item.includes("*") && key.startsWith(item.split("*")[0]));
        if (pattern) {
          const value = manifest.exports[pattern];
          target = (typeof value === "string" ? value : value.import ?? value.default).replace("*", key.slice(pattern.indexOf("*")));
        }
      }
      target = typeof target === "string" ? target : target?.import ?? target?.default;
      if (!target) throw new Error(`Missing SDK import export: ${name}`);
      return import(new URL(target, pathToFileURL(manifestPath)).href);
    }
    if (dirname(directory) === directory) throw new Error(`Cannot find the host SDK: ${packageName}`);
  }
}
export const sdk = await hostImport("@earendil-works/pi-durable");
export const { BACKGROUND_CONTEXT: context } = await hostImport("@earendil-works/chord/context");
export const { createModels } = await hostImport("@earendil-works/pi-ai/models");
export const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await hostImport("@earendil-works/pi-ai/providers/faux");
export const { openNodeSqliteStorage } = await hostImport("@earendil-works/pi-durable/storage/sqlite/node");
const { codingRegistry, codingEnv } = await import(pathToFileURL(join(root, "src/coding.ts")).href);
const { Resources } = await import(pathToFileURL(join(root, "src/resources.ts")).href);
export const { executeExtensionCommand, extensionCommands } = await import(pathToFileURL(join(root, "src/extension-ui.ts")).href);
const extension = fileURLToPath(new URL("../extension.mjs", import.meta.url));
export const call = (name, args = {}) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
export const bridgeTasks = async (harness) => (await harness.inspect(context)).tasks.filter((task) => task.record.kind === "pi-d-web.bridge");

export async function openFixtureSession(directory, responses = [], options = {}) {
  const faux = options.faux ?? fauxProvider({ tokensPerSecond: 100000 });
  faux.appendResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  const registry = await codingRegistry(new Resources(join(directory, "config"), [], directory), [extension]);
  const file = options.file ?? join(directory, "session.sqlite");
  const harness = await sdk.Harness.open(await openNodeSqliteStorage(file), { models, registry, env: codingEnv }, context);
  const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });
  return { harness, conversation, faux, file, async run(text) {
    const input = await conversation.submit({ type: "input", content: text }, context);
    return input.wait(context);
  } };
}
