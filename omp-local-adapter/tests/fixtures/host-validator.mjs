// Exact AST-extracted functions from @paperclipai/server 2026.1005.0.
// Not the full server/registry loader; no logger or plugin-store initialization.
import fs from 'node:fs';
import path from 'node:path';
import {validateAdapterLoginCapability} from '@paperclipai/adapter-utils';
function resolvePackageEntryPoint(packageDir) {
    const pkgJsonPath = path.join(packageDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    if (pkg.exports && typeof pkg.exports === "object" && pkg.exports["."]) {
        const exp = pkg.exports["."];
        return typeof exp === "string" ? exp : (exp.import ?? exp.default ?? "index.js");
    }
    return pkg.main ?? "index.js";
}
export function validateAdapterModule(mod, packageName) {
    const m = mod;
    const createServerAdapter = m.createServerAdapter;
    if (typeof createServerAdapter !== "function") {
        throw new Error(`Package "${packageName}" does not export createServerAdapter(). ` +
            `Ensure the package's main entry exports a createServerAdapter function.`);
    }
    const adapterModule = createServerAdapter();
    if (!adapterModule || !adapterModule.type) {
        throw new Error(`createServerAdapter() from "${packageName}" returned an invalid module (missing "type").`);
    }
    // Fail closed on a malformed login capability. The validator throws a clear
    // error, so the loader rejects the adapter instead of loading it with a
    // partial capability.
    try {
        validateAdapterLoginCapability(adapterModule);
    }
    catch (err) {
        throw new Error(`createServerAdapter() from "${packageName}" returned an invalid login capability: ` +
            `${err instanceof Error ? err.message : String(err)}`);
    }
    return adapterModule;
}
export {resolvePackageEntryPoint};
