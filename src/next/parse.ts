import { StyleHeader } from "../resolver/processSFC";
import { ModuleInformation, ModuleResolver } from "./moduleResolver";
import { ZipeCache } from "./cache";
import { posix } from "path";
import { ZipeParser } from "./parser";
import { ZipeScriptTransform } from "./transformers";
import { resolveImport, parseImportsExports } from "../parseImports";

const debug = require("debug")("zipe:parse");

export interface ZipeDependency {
  // ./App.vue
  module: string;

  // './App.vue'
  importPath: string;

  // import {} from 'asdasd';
  importLine: string;

  info: ModuleInformation;

  // dynamic imported
  dynamic: boolean;
}

export interface ZipeModule {
  // // relative path to root aka publicPath
  // relativePath: string;

  // filename
  name: string;

  // filePath: string;

  extension: string;

  rawContent: string;

  dependencies: ZipeDependency[];

  fullDependencies: ZipeDependency[];

  module: ModuleInformation;

  extra: {
    styles: StyleHeader[];

    raw: {};
  };

  code: string | null;
  map: string | undefined;

  sfc: {
    scopeId: string | undefined;
    styles: {
      code: string;
      map: string | undefined;
      modules: Record<string, string> | undefined;
    };
    template: { code: string; map: string | undefined };
    script: {
      code: string;
      map: string | undefined;
      dependencies: ZipeDependency[];
      exports: string[];
    };
  };

  exports: string[];

  // promise of all dependencies, useful to await if every single dependency is sorted
  dependenciesPromise: Promise<ZipeDependency[]> | null;
}

export async function parse(
  filePath: string,
  importer: string,
  resolver: ModuleResolver,
  fileCache: ZipeCache<string, string>,
  dependenciesCache: ZipeCache<string, ZipeModule>,
  sfcParser: ZipeParser,
  transformers: Record<string, ZipeScriptTransform | undefined>
): Promise<ZipeModule> {
  const module = await resolver.info(filePath, importer);
  const name = posix.basename(module.name);
  const extension = posix.extname(module.path).slice(1);

  // if (dependenciesCache.has(module.path)) {
  //   debug(`serving cached '${module.path}'`);
  //   return dependenciesCache.get(module.path);
  // }

  const item: ZipeModule = {
    name,
    module,
    extension,
    rawContent: "",
    code: null,
    map: undefined,
    dependencies: [],
    fullDependencies: [],
    exports: [],
    extra: {
      styles: [],
      raw: {},
    },
    sfc: {
      scopeId: undefined,
      script: {
        code: "",
        dependencies: [],
        exports: [],
        map: undefined,
      },
      styles: {
        code: "",
        map: undefined,
        modules: undefined,
      },
      template: {
        code: "",
        map: undefined,
      },
    },
    dependenciesPromise: null,
  };
  dependenciesCache.set(module.path, item);

  // console.log('module item', module )
  const rawContent = (item.rawContent = await fileCache.get<string>(
    module.name
  ));
  // console.log('2213module item', module )

  if (extension === "vue") {
    const { extra } = await sfcParser(rawContent, filePath, transformers);
    item.sfc = extra;

    const [imports, exports] = parseImportsExports(
      item.sfc.script.code,
      module.name,
      resolver
    );

    item.sfc.script.dependencies = imports;
    item.sfc.script.exports = exports;

    item.dependencies.push(...imports);
  } else {
    const transformer = transformers[extension];
    if (transformer) {
      let start = Date.now();
      // TODO add transformer options, probably build transformers?
      const { code, map } = await transformer(rawContent, filePath, {});
      debug(`${filePath} transformed in ${Date.now() - start}ms.`);

      item.code = code;
      item.map = map as string;
      const [imports, exports] = parseImportsExports(
        item.sfc.script.code,
        module.name,
        resolver
      );

      item.dependencies.push(...imports);
      item.exports.push(...exports);

      debug(`${filePath} imports parsed in ${Date.now() - start}ms.`);
    } else {
      console.warn(`[zipe] no transformer found for ${filePath}`);
    }
  }

  item.fullDependencies.push(...item.dependencies);
  const promises = [];
  for (const dependency of item.dependencies.filter((x) => !x.info.module)) {
    promises.push(
      parse(
        dependency.info.path,
        item.module.path,
        resolver,
        fileCache,
        dependenciesCache,
        sfcParser,
        transformers
      ).then((x) => {
        item.extra.styles.push(...x.extra.styles);
        item.fullDependencies.push(...x.fullDependencies);
      })
    );
  }

  await Promise.all(promises);

  return item;
}
