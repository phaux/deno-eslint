import { join, toFileUrl } from "jsr:@std/path@1.0.2";
import { expandGlob } from "jsr:@std/fs@1.0.1";
import * as ts from "npm:typescript@5.5.4";
import { VfsHost } from "./VfsHost.ts";
import {
  ConsoleHandler,
  debug,
  error,
  info,
  setup,
  warn,
} from "jsr:@std/log@0.224.5";

setup({
  handlers: {
    console: new ConsoleHandler("INFO"),
  },
  loggers: {
    default: { level: "DEBUG", handlers: ["console"] },
    VfsHost: { level: "DEBUG", handlers: ["console"] },
  },
});

/**
 * Type of `deno.json` file.
 */
interface DenoConfig {
  compilerOptions?: ts.CompilerOptions;
  exports?: string | Record<string, string>;
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
}

/**
 * Creates a TypeScript program for a Deno project.
 *
 * Loads compiler options, entry file paths, and import map from `deno.json` if exists.
 *
 * Uses {@link VfsHost} internally.
 *
 * @param [options] Options object.
 * @param [options.rootDir] Root directory of the project.
 * Used by TS program and to find `deno.json`.
 * Default is current working directory.
 * @param [options.entryGlob] Glob pattern to find additional entry files.
 * Default is all JS/TS files.
 * @param [options.importMap] Additional import map entries.
 * @param [options.compilerOptions] TypeScript compiler options.
 */
export async function createDenoProgram(options: {
  rootDir?: string;
  entryGlob?: string;
  importMap?: import("./VfsHost.ts").ImportMap;
  compilerOptions?: ts.CompilerOptions;
} = {}): Promise<ts.Program> {
  let {
    rootDir = Deno.cwd(),
    entryGlob = "**/*.{mts,ts,tsx,mjs,js,jsx}",
    importMap = {},
    compilerOptions,
  } = options;

  // find entry files
  const entryFiles = await Array.fromAsync(
    expandGlob(entryGlob, { root: rootDir, includeDirs: false }),
  ).then((entries) => entries.map((entry) => toFileUrl(entry.path)));

  // default Deno compiler options
  compilerOptions = {
    allowImportingTsExtensions: true,
    allowJs: true,
    allowSyntheticDefaultImports: true,
    checkJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    lib: [
      "es2023",
      "dom",
      "deno.ns.d.ts",
      "deno.net.d.ts",
      "deno.fetch.d.ts",
      "deno.unstable.d.ts",
    ],
    module: ts.ModuleKind.NodeNext,
    moduleDetection: ts.ModuleDetectionKind.Auto,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    useUnknownInCatchVariables: false,
    ...compilerOptions,
  };

  // load deno.json if exists
  {
    const denoConfigPath = join(rootDir, "deno.json");

    if (await Deno.stat(denoConfigPath).catch(() => null) != null) {
      try {
        const denoConfigUrl = toFileUrl(denoConfigPath);
        const denoConfig = JSON.parse(
          await Deno.readTextFile(denoConfigUrl),
        ) as DenoConfig;
        if (denoConfig.compilerOptions != null) {
          compilerOptions = {
            ...compilerOptions,
            ...denoConfig.compilerOptions,
          };
        }
        if (denoConfig.imports != null) {
          const imports = Object.fromEntries(
            Object.entries(denoConfig.imports)
              .map((
                [specifier, url],
              ) => [specifier, new URL(url, denoConfigUrl)]),
          );
          importMap = {
            ...importMap,
            imports: { ...importMap?.imports, ...imports },
          };
        }
        if (denoConfig.scopes != null) {
          const scopes = Object.fromEntries(
            Object.entries(denoConfig.scopes).map(([scope, imports]) => [
              scope,
              Object.fromEntries(
                Object.entries(imports).map(([specifier, url]) => [
                  specifier,
                  new URL(url, denoConfigUrl),
                ]),
              ),
            ]),
          );
          importMap = {
            ...importMap,
            scopes: { ...importMap?.scopes, ...scopes },
          };
        }

        if (denoConfig.exports != null) {
          const denoExports = typeof denoConfig.exports == "object"
            ? Object.values(denoConfig.exports)
            : [denoConfig.exports];
          for (const entry of denoExports) {
            const entryUrl = toFileUrl(join(rootDir, entry));
            if (!entryFiles.includes(entryUrl)) {
              entryFiles.push(entryUrl);
            }
          }
        }
      } catch (err) {
        error(`Failed to load deno.json: ${String(err)}`);
      }
    }
  }

  // init vfs compiler host
  const host = new VfsHost({
    rootDir: toFileUrl(rootDir),
    defaultLibDir: new URL(
      "https://raw.githubusercontent.com/denoland/deno/main/cli/tsc/dts",
    ),
    importMap,
  });

  // add top level package.json with type: module
  host.set(
    // join(host.getCurrentDirectory(), "package.json"),
    "/package.json",
    '{ "type": "module" }',
  );

  // load default lib files
  await Promise.all(
    (compilerOptions?.lib ?? []).map((libName) => host.loadLibFile(libName)),
  );

  // load jsxImportSource
  let jsxImportSource = compilerOptions?.jsxImportSource;
  if (jsxImportSource != null) {
    jsxImportSource = await host.loadFile(
      new URL(`${jsxImportSource}/jsx-runtime`),
    );
  }

  // load entry files
  const rootNames = await Promise.all(
    entryFiles.map((url) => host.loadFile(url)),
  );

  // debug: print some files
  // for (const [path, text] of host) {
  //   if (/\bjsx-runtime\b/.test(path)) {
  //     info(`${path}:\n${text}`);
  //   }
  // }

  // create program
  const program = ts.createProgram({
    rootNames,
    options: { ...compilerOptions, jsxImportSource },
    host,
  });

  // log type errors if any
  const diagnostics = ts.getPreEmitDiagnostics(program);
  for (const diagnostic of diagnostics) {
    let message = "";
    if (diagnostic.file != null && diagnostic.start != null) {
      const pos = diagnostic.file
        .getLineAndCharacterOfPosition(diagnostic.start);
      message += `${diagnostic.file.fileName}:${pos.line}:${pos.character}: `;
    }
    message += ts.flattenDiagnosticMessageText(diagnostic.messageText, " ", 0);
    if (diagnostic.file?.fileName.startsWith(host.getCurrentDirectory())) {
      warn(`TS Error in project: ${message}`);
    } else if (
      diagnostic.file?.fileName.startsWith(host.getDefaultLibLocation())
    ) {
      debug(`TS Error in default lib: ${message}`);
    } else {
      info(`TS Error in dependency: ${message}`);
    }
  }

  return program;
}
