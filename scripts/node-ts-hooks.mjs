import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcRoot = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src") + "/");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(specifier.slice(2) + ".ts", srcRoot).href, context);
    }
    if (specifier.startsWith(".") && !/\.\w+$/.test(specifier)) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(specifier + ".ts", context);
      }
    }
    return nextResolve(specifier, context);
  },
});
