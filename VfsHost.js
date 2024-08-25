// @ts-check
import { parse } from "jsr:@std/path";
import MagicString from "https://esm.sh/magic-string";
import * as ts from "npm:typescript";
import { getLogger } from "jsr:@std/log";
import { memoizedFetch } from "./memoizedFetch.js";

const logger = () => getLogger("VfsHost");

/**
 * @typedef {object} ImportMap
 * @property {Record<string, URL>} [imports]
 * @property {Record<string, Record<string, URL>>} [scopes]
 */

/**
 * TypeScript Compiler Host implementation that uses a Virtual File System.
 *
 * @extends {Map<string, string>}
 * @implements {ts.CompilerHost}
 */
export class VfsHost extends Map {
  /**
   * Create a new virtual file system compiler host.
   *
   * @param {object} options
   * @param {URL} options.rootDir
   * @param {URL} options.defaultLibDir
   * @param {ImportMap} [options.importMap]
   */
  constructor(options) {
    super();
    this.rootDir = options.rootDir;
    this.defaultLibDir = options.defaultLibDir;
    this.importMap = options.importMap;
  }

  /**
   * Load a lib file and add it to the program's virtual FS.
   *
   * Will try to load from {@link defaultLibDir} first, then from the local dts directory.
   *
   * @param {string} libName
   *
   * @returns {Promise<void>}
   *
   * @throws {Error} If the file couldn't be loaded.
   */
  async loadLibFile(libName) {
    let fileName = libName.toLowerCase();
    if (!fileName.startsWith("lib.")) fileName = `lib.${fileName}`;
    if (!fileName.endsWith(".d.ts")) fileName += ".d.ts";
    const fileUrl = joinUrl(this.defaultLibDir, fileName);
    try {
      await this.loadFile(fileUrl);
    } catch (err1) {
      try {
        const localFileUrl = new URL(
          `dts/${fileName}.txt`,
          import.meta.url,
        );
        await this.loadFile(localFileUrl, fileUrl);
      } catch (err2) {
        logger().warn(
          `Loading lib file ${
            JSON.stringify(libName)
          } failed: ${err1}. ${err2}.`,
        );
      }
    }
  }

  /**
   * Load a file and all its dependencies and add them to the program's virtual FS.
   *
   * The file's imports will be rewritten to match the fake paths.
   *
   * If the file has types, the types will be loaded instead.
   *
   * @param {URL} url
   * @param {URL} [asUrl]
   *
   * @returns {Promise<string>} Path to import the file from.
   *
   * @throws {Error} If the file couldn't be loaded.
   */
  async loadFile(url, asUrl) {
    try {
      const { text, url: realUrl } = await this.#fetchFile(url);
      const fakePath = this.#urlToFakePath(asUrl ?? realUrl);
      if (this.has(fakePath)) return fakePath;
      this.set(fakePath, ""); // prevent infinite recursion
      const file = await this.#transformSourceFile(
        realUrl,
        ts.createSourceFile(fakePath, text, ts.ScriptTarget.ESNext),
      );
      this.set(fakePath, file.text);
      if (!fakePath.startsWith(this.getDefaultLibLocation())) {
        logger().debug(
          `Loaded ${realUrl.href} (${file.text.length} bytes)`,
        );
      }
      return fakePath;
    } catch (err) {
      throw new Error(`Loading file ${url.href} failed: ${err}`);
    }
  }

  /**
   * Fetch a source file or its types and return its content and URL.
   *
   * Always prefers types over source.
   * If a remote file doesn't have appropriate extension, it will be added.
   *
   * @param {URL} url
   * @returns {Promise<{ text: string, url: URL }>}
   */
  async #fetchFile(url) {
    switch (url.protocol) {
      case "file:": {
        const text = await Deno.readTextFile(url);
        return { text, url };
      }
      case "https:": {
        const resp = await memoizedFetch(url);
        const typesUrl = resp.headers["x-typescript-types"];
        if (typesUrl != null) {
          const typesResp = await memoizedFetch(new URL(typesUrl, resp.url));
          let typesRespUrl = typesResp.url;
          if (!typesRespUrl.endsWith(".d.ts")) typesRespUrl += ".d.ts";
          return { text: typesResp.text, url: new URL(typesRespUrl) };
        }
        let respUrl = resp.url;
        if (!/\.[cm]?[tj]sx?$/.test(respUrl)) respUrl += ".ts"; // guess
        return { text: resp.text, url: new URL(resp.url) };
      }
      case "npm:":
        return await this.#fetchFile(
          new URL(url.pathname, "https://esm.sh/"),
        );
      case "jsr:":
        return await this.#fetchFile(
          new URL(url.pathname, "https://esm.sh/jsr/"),
        );
      default:
        throw new Error(`Fetching ${url.protocol} URL is not supported`);
    }
  }

  /**
   * Rewrite URL to a local (possibly fake) path.
   *
   * Should return real path for FS URLs.
   *
   * @param {URL} url
   * @returns {string}
   */
  #urlToFakePath(url) {
    if (url.protocol === "file:") {
      return url.pathname;
    }
    if (url.protocol === "https:") {
      const path = `/https/${url.host}${url.pathname}`;
      return path;
    }
    throw new Error(`Can't create fake path from ${url.protocol} URL`);
  }

  /**
   * Transforms imports in a source file.
   *
   * @param {URL} realUrl
   * @param {ts.SourceFile} file
   * @returns {Promise<ts.SourceFile>}
   */
  async #transformSourceFile(
    realUrl,
    file,
  ) {
    /** @param {string} specifier */
    const toFakeJs = (specifier) => {
      if (specifier.endsWith(".d.ts")) {
        return specifier.slice(0, -5) + ".js";
      }
      return specifier;
    };

    try {
      const text = new MagicString(file.getFullText());

      // transform jsxImportSource
      const jsxImportMatch = file.getFullText().match(
        /@jsxImportSource\s+(\S+)/d,
      );
      if (jsxImportMatch) {
        if (jsxImportMatch.indices != null) {
          text.overwrite(
            jsxImportMatch.indices[1][0],
            jsxImportMatch.indices[1][1],
            await this.#transformSpecifier(
              realUrl,
              `${jsxImportMatch[1]}/jsx-runtime`,
            ),
          );
        }
      }

      // transform triple slash path directives
      await Promise.all((Array.from(
        file.getFullText().matchAll(
          /^\s*\/\/\/\s*<reference\s+path="([^"]+)"\s*\/>/dgm,
        ),
      )).map(async (match) => {
        if (match.indices == null) return;
        text.overwrite(
          match.indices[1][0],
          match.indices[1][1],
          await this.#transformSpecifier(realUrl, match[1]),
        );
      }));

      // load triple slash lib directives
      await Promise.all((Array.from(
        file.getFullText().matchAll(
          /^\s*\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/dgm,
        ),
      )).map(async (match) => {
        if (match.indices == null) return;
        await this.loadLibFile(match[1]);
      }));

      // transform nodes

      /**
       * If this is an import/export statement, transform the module specifier.
       * Else, recurse into children.
       *
       * @param {ts.Node} node
       */
      const transformTsNode = async (node) => {
        // static import/export
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const specifier = node.moduleSpecifier;
          if (specifier && ts.isStringLiteral(specifier)) {
            text.overwrite(
              specifier.getFullStart() + 2,
              specifier.getEnd() - 1,
              toFakeJs(await this.#transformSpecifier(realUrl, specifier.text)),
            );
          }
        }
        // dynamic import
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          const specifier = node.arguments[0];
          if (specifier && ts.isStringLiteral(specifier)) {
            text.overwrite(
              specifier.getFullStart() + 2,
              specifier.getEnd() - 1,
              toFakeJs(await this.#transformSpecifier(realUrl, specifier.text)),
            );
          }
        }

        // recurse into children
        /** @type {ts.Node[]} */
        const children = [];
        node.forEachChild((child) => {
          children.push(child);
        });
        await Promise.all(children.map((child) => transformTsNode(child)));
      };
      await transformTsNode(file);

      return ts.createSourceFile(
        file.fileName,
        text.toString(),
        file.languageVersion,
      );
    } catch (err) {
      throw new Error(
        `Transforming file ${realUrl.href} failed: ${err}`,
        { cause: err },
      );
    }
  }

  /**
   * Transforms the import specifier and loads the file it points to.
   *
   * @param {URL} sourceUrl Url of the importing file.
   * @param {string} specifier Import specifier to resolve.
   * @returns {Promise<string>} Fake path to import the loaded file from.
   * If the file failed to load, the original specifier is returned.
   */
  async #transformSpecifier(sourceUrl, specifier) {
    try {
      let resolvedScope = ""; // longest scope match wins
      let resolvedPrefix = ""; // then, longest prefix match wins
      let resolvedUrl = /** @type {URL | null} */ (null);

      // rewrite using import map imports
      for (
        const [prefix, replacement] of Object.entries(
          this.importMap?.imports ?? {},
        )
      ) {
        if (
          specifier === prefix ||
          (prefix.endsWith("/") && specifier.startsWith(prefix) &&
            prefix.length > resolvedPrefix.length)
        ) {
          resolvedPrefix = prefix;
          resolvedUrl = new URL(
            replacement.href + specifier.slice(prefix.length),
          );
        }
      }

      // rewrite using import map scopes
      for (
        const [scope, mappings] of Object.entries(this.importMap?.scopes ?? {})
      ) {
        if (
          sourceUrl.href.startsWith(scope) &&
          scope.length > resolvedScope.length
        ) {
          for (const [prefix, replacement] of Object.entries(mappings)) {
            if (
              specifier === prefix ||
              (prefix.endsWith("/") && specifier.startsWith(prefix) &&
                prefix.length > resolvedPrefix.length)
            ) {
              resolvedScope = scope;
              resolvedPrefix = prefix;
              resolvedUrl = new URL(
                replacement.href + specifier.slice(prefix.length),
              );
            }
          }
        }
      }

      if (resolvedUrl == null) {
        if (isBareSpecifier(specifier)) {
          throw new Error(
            `Bare specifier ${
              JSON.stringify(specifier)
            } encountered in ${sourceUrl.href}`,
          );
        }
        resolvedUrl = new URL(specifier, sourceUrl);
      }

      const fakePath = await this.loadFile(resolvedUrl);

      return fakePath;
    } catch (err) {
      logger().error(
        `Transforming specifier ${
          JSON.stringify(specifier)
        } in ${sourceUrl.href} failed: ${String(err)}`,
      );
      return specifier;
    }
  }

  // CompilerHost methods

  /**
   * @param {string} fileName
   * @param {ts.ScriptTarget | ts.CreateSourceFileOptions} options
   * @returns {ts.SourceFile | undefined}
   */
  getSourceFile(
    fileName,
    options,
  ) {
    const sourceText = this.readFile(fileName);
    if (sourceText == null) return;
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceText,
      options,
      undefined,
      undefined,
    );
    return sourceFile;
  }

  getDefaultLibFileName() {
    return this.#urlToFakePath(joinUrl(this.defaultLibDir, "lib.d.ts"));
  }

  getDefaultLibLocation() {
    return this.#urlToFakePath(this.defaultLibDir);
  }

  getCurrentDirectory() {
    return this.#urlToFakePath(this.rootDir);
  }

  getCanonicalFileName(/** @type {string} */ fileName) {
    return fileName;
  }

  useCaseSensitiveFileNames() {
    return true;
  }

  getNewLine() {
    return "\n";
  }

  fileExists(/** @type {string} */ fileName) {
    const exists = this.readFile(fileName, true) != null;
    if (!exists && !/\/node_modules\/|\/package.json$/.test(fileName)) {
      logger().debug(`Checked exists: ${fileName} - ${exists}`);
    }
    return exists;
  }

  readFile(/** @type {string} */ fileName, checkOnly = false) {
    let foundName = fileName;

    // remove `/jsx-runtime` from the end of the file name
    if (foundName.endsWith("/jsx-runtime")) {
      foundName = foundName.slice(0, -11);
    }

    // rewrite lib file name
    if (foundName.startsWith(this.getDefaultLibLocation())) {
      let { dir, name, ext } = parse(foundName);
      name = name.toLowerCase();
      ext = ext.toLowerCase();
      if (!name.startsWith("lib.")) name = `lib.${name}`;
      if (!name.endsWith(".d")) name += ".d";
      if (ext !== ".ts") ext = ".ts";
      foundName = `${dir}/${name}${ext}`;
    }

    // get the file
    const sourceText = this.get(foundName);
    if (sourceText == null) {
      if (!checkOnly) logger().warn(`File not found: ${foundName}`);
      return undefined;
    }

    if (foundName === fileName) {
      if (!foundName.startsWith(this.getDefaultLibLocation())) {
        logger().debug(`Read ${fileName}`);
      }
      return sourceText;
    }

    if (!foundName.startsWith(this.getDefaultLibLocation())) {
      logger().info(`Read ${fileName} as ${foundName}`);
    }
    // return sourceText;
    return `/// <reference no-default-lib="true" />\n` +
      `/// <reference path="${foundName}" />\n`;
  }

  writeFile() {
    throw new Error("writeFile not implemented");
  }
}

/**
 * Checks if a specifier is a bare specifier.
 * @param {string} specifier
 */
function isBareSpecifier(specifier) {
  try {
    new URL(specifier);
    return false;
  } catch { /* ignore */ }

  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

/**
 * Joins paths to a URL.
 * @param {URL} url
 * @param {...string} paths
 */
function joinUrl(url, ...paths) {
  return paths.reduce((url, path) => {
    if (!url.href.endsWith("/")) url = new URL(`${url.href}/`);
    return new URL(path, url);
  }, url);
}