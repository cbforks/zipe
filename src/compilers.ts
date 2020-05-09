// FROM vite

import chalk from "chalk";
import path from "path";
import {
  SFCBlock,
  SFCDescriptor,
  SFCTemplateBlock,
  SFCStyleBlock,
  SFCStyleCompileResults,
  generateCodeFrame,
} from "@vue/compiler-sfc";
import hash_sum from "hash-sum";
import LRUCache from "lru-cache";
import resolve from "resolve-from";
import { Context } from "koa";
import { InternalResolver } from "vite/dist/resolver";
import { transform } from "vite/dist/esbuildService";
import { cachedRead } from "vite";
import { resolveCompiler } from "./utils";
import { hmrClientId } from "vite/dist/server/serverPluginHmr";
import { genSourceMapString, loadPostcssConfig } from "vite/dist/utils";

const debug = require("debug")("vite:sfc");

export const srcImportMap = new Map();

interface CacheEntry {
  descriptor?: SFCDescriptor;
  template?: string;
  script?: string;
  styles: SFCStyleCompileResults[];
}

export const vueCache = new LRUCache<string, CacheEntry>({
  max: 65535,
});

export async function parseSFC(
  root: string,
  filename: string,
  content?: string | Buffer
): Promise<SFCDescriptor | undefined> {
  let cached = vueCache.get(filename);
  if (cached && cached.descriptor) {
    debug(`${filename} parse cache hit`);
    return cached.descriptor;
  }

  if (!content) {
    try {
      content = await cachedRead(null, filename);
    } catch (e) {
      return;
    }
  }

  if (typeof content !== "string") {
    content = content.toString();
  }

  const start = Date.now();
  const { descriptor, errors } = resolveCompiler(root).parse(content, {
    filename,
    sourceMap: true,
  });

  if (errors.length) {
    console.error(chalk.red(`\n[vite] SFC parse error: `));
    errors.forEach((e) => {
      console.error(
        chalk.underline(
          `${filename}:${e.loc!.start.line}:${e.loc!.start.column}`
        )
      );
      console.error(chalk.yellow(e.message));
      console.error(
        generateCodeFrame(
          content as string,
          e.loc!.start.offset,
          e.loc!.end.offset
        )
      );
    });
  }

  cached = cached || { styles: [] };
  cached.descriptor = descriptor;
  vueCache.set(filename, cached);
  debug(`${filename} parsed in ${Date.now() - start}ms.`);
  return descriptor;
}

async function compileSFCMain(
  descriptor: SFCDescriptor,
  filePath: string,
  publicPath: string
): Promise<string> {
  let cached = vueCache.get(filePath);
  if (cached && cached.script) {
    return cached.script;
  }

  let code = "";
  if (descriptor.script) {
    let content = descriptor.script.content;
    if (descriptor.script.lang === "ts") {
      content = (await transform(content, publicPath, { loader: "ts" })).code;
    }

    code += content.replace(`export default`, "const __script =");
  } else {
    code += `const __script = {}`;
  }

  const id = hash_sum(publicPath);
  let hasScoped = false;
  let hasCSSModules = false;
  if (descriptor.styles) {
    code += `\nimport { updateStyle } from "${hmrClientId}"\n`;
    descriptor.styles.forEach((s, i) => {
      const styleRequest = publicPath + `?type=style&index=${i}`;
      if (s.scoped) hasScoped = true;
      if (s.module) {
        if (!hasCSSModules) {
          code += `\nconst __cssModules = __script.__cssModules = {}`;
          hasCSSModules = true;
        }
        const styleVar = `__style${i}`;
        const moduleName = typeof s.module === "string" ? s.module : "$style";
        code += `\nimport ${styleVar} from ${JSON.stringify(
          styleRequest + "&module"
        )}`;
        code += `\n__cssModules[${JSON.stringify(moduleName)}] = ${styleVar}`;
      }
      code += `\nupdateStyle("${id}-${i}", ${JSON.stringify(styleRequest)})`;
    });
    if (hasScoped) {
      code += `\n__script.__scopeId = "data-v-${id}"`;
    }
  }

  if (descriptor.template) {
    code += `\nimport { render as __render } from ${JSON.stringify(
      publicPath + `?type=template`
    )}`;
    code += `\n__script.render = __render`;
  }
  code += `\n__script.__hmrId = ${JSON.stringify(publicPath)}`;
  code += `\n__script.__file = ${JSON.stringify(filePath)}`;
  code += `\nexport default __script`;

  if (descriptor.script) {
    code += genSourceMapString(descriptor.script.map);
  }

  cached = cached || { styles: [] };
  cached.script = code;
  vueCache.set(filePath, cached);
  return code;
}

function compileSFCTemplate(
  root: string,
  template: SFCTemplateBlock,
  filename: string,
  publicPath: string,
  scoped: boolean
): string {
  let cached = vueCache.get(filename);
  if (cached && cached.template) {
    debug(`${publicPath} template cache hit`);
    return cached.template;
  }

  const start = Date.now();
  const { code, map, errors } = resolveCompiler(root).compileTemplate({
    source: template.content,
    filename,
    inMap: template.map,
    transformAssetUrls: {
      base: path.posix.dirname(publicPath),
    },
    compilerOptions: {
      scopeId: scoped ? `data-v-${hash_sum(publicPath)}` : null,
      runtimeModuleName: "/@modules/vue",
    },
    preprocessLang: template.lang,
    preprocessCustomRequire: (id: string) => require(resolve(root, id)),
  });

  if (errors.length) {
    console.error(chalk.red(`\n[vite] SFC template compilation error: `));
    errors.forEach((e) => {
      if (typeof e === "string") {
        console.error(e);
      } else {
        console.error(
          chalk.underline(
            `${filename}:${e.loc!.start.line}:${e.loc!.start.column}`
          )
        );
        console.error(chalk.yellow(e.message));
        const original = template.map!.sourcesContent![0];
        console.error(
          generateCodeFrame(original, e.loc!.start.offset, e.loc!.end.offset)
        );
      }
    });
  }

  const finalCode = code + genSourceMapString(map);
  cached = cached || { styles: [] };
  cached.template = finalCode;
  vueCache.set(filename, cached);

  debug(`${publicPath} template compiled in ${Date.now() - start}ms.`);
  return finalCode;
}

async function compileSFCStyle(
  root: string,
  style: SFCStyleBlock,
  index: number,
  filename: string,
  publicPath: string
): Promise<SFCStyleCompileResults> {
  let cached = vueCache.get(filename);
  const cachedEntry = cached && cached.styles && cached.styles[index];
  if (cachedEntry) {
    debug(`${publicPath} style cache hit`);
    return cachedEntry;
  }

  const start = Date.now();
  const id = hash_sum(publicPath);
  const postcssConfig = await loadPostcssConfig(root);

  const result = await resolveCompiler(root).compileStyleAsync({
    source: style.content,
    filename,
    id: `data-v-${id}`,
    scoped: style.scoped != null,
    modules: style.module != null,
    preprocessLang: style.lang as any,
    preprocessCustomRequire: (id: string) => require(resolve(root, id)),
    ...(postcssConfig
      ? {
          postcssOptions: postcssConfig.options,
          postcssPlugins: postcssConfig.plugins,
        }
      : {}),
  });

  if (result.errors.length) {
    console.error(chalk.red(`\n[vite] SFC style compilation error: `));
    result.errors.forEach((e: any) => {
      if (typeof e === "string") {
        console.error(e);
      } else {
        const lineOffset = style.loc.start.line - 1;
        if (e.line && e.column) {
          console.log(
            chalk.underline(`${filename}:${e.line + lineOffset}:${e.column}`)
          );
        } else {
          console.log(chalk.underline(filename));
        }
        const filenameRE = new RegExp(
          ".*" +
            path.basename(filename).replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&") +
            "(:\\d+:\\d+:\\s*)?"
        );
        const cleanMsg = e.message.replace(filenameRE, "");
        console.error(chalk.yellow(cleanMsg));
        if (e.line && e.column && cleanMsg.split(/\n/g).length === 1) {
          const original = style.map!.sourcesContent![0];
          const offset =
            original
              .split(/\r?\n/g)
              .slice(0, e.line + lineOffset - 1)
              .map((l) => l.length)
              .reduce((total, l) => total + l + 1, 0) +
            e.column -
            1;
          console.error(generateCodeFrame(original, offset, offset + 1));
        }
      }
    });
  }

  cached = cached || { styles: [] };
  cached.styles[index] = result;
  vueCache.set(filename, cached);

  debug(`${publicPath} style compiled in ${Date.now() - start}ms`);
  return result;
}