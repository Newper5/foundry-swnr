/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
import * as gulp from "gulp";
import * as fs from "fs-extra";
import * as path from "path";
import * as chalk from "chalk";
import * as archiver from "archiver";
import * as typescript from "typescript";
import * as os from "os";

import * as ts from "gulp-typescript";
import * as less from "gulp-less";
import * as sass from "gulp-sass";
import * as gyaml from "gulp-yaml";
import * as filelist from "gulp-filelist";
import * as rename from "gulp-rename";
import * as sourcemaps from "gulp-sourcemaps";
import mergeStream = require("merge-stream");
import * as concat from "gulp-concat";
import * as yaml from "js-yaml";

import * as through2 from "through2";
import * as debug from "gulp-debug";
import * as yargs from "yargs";

import * as glob from "glob";

import { createHash } from "crypto";

const argv = yargs.options("clean", {
  alias: "c",
  default: false,
}).argv;

import * as sassComp from "sass";
(<{ compiler: unknown }>(<never>sass)).compiler = sassComp;

function getConfig() {
  const configPath = path.resolve(process.cwd(), "foundryconfig.json");
  let config: { dataPath: string };

  if (fs.existsSync(configPath)) {
    config = fs.readJSONSync(configPath);
    return config;
  } else {
    return;
  }
}

function getManifest() {
  let file: Record<string, unknown>;
  let name: string;
  let root: string;

  if (fs.existsSync("src")) {
    root = "src";
  } else {
    root = "dist";
  }

  const modulePath = path.join(root, "module.yml");
  const systemPath = path.join(root, "system.yml");

  if (fs.existsSync(modulePath)) {
    file = yaml.load(fs.readFileSync(modulePath, "utf-8"));
    name = "module.yml";
  } else if (fs.existsSync(systemPath)) {
    file = yaml.load(fs.readFileSync(systemPath, "utf-8"));
    name = "system.yml";
  } else {
    return;
  }

  return { name, file, root };
}

/**
 * TypeScript transformers
 * @returns {typescript.TransformerFactory<typescript.SourceFile>}
 */
function createTransformer(): typescript.TransformerFactory<
  typescript.SourceFile
> {
  function shouldMutateModuleSpecifier(node: typescript.Node) {
    if (
      !typescript.isImportDeclaration(node) &&
      !typescript.isExportDeclaration(node)
    )
      return false;
    if (node.moduleSpecifier === undefined) return false;
    if (!typescript.isStringLiteral(node.moduleSpecifier)) return false;
    if (
      !node.moduleSpecifier.text.startsWith("./") &&
      !node.moduleSpecifier.text.startsWith("../")
    )
      return false;
    if (path.extname(node.moduleSpecifier.text) !== "") return false;
    return true;
  }

  /**
   * Transforms import/export declarations to append `.js` extension
   */
  function importTransformer(context: typescript.TransformationContext) {
    return (node: typescript.SourceFile) => {
      function visitor(node: typescript.Node) {
        if (shouldMutateModuleSpecifier(node)) {
          if (typescript.isImportDeclaration(node)) {
            const newModuleSpecifier = typescript.createLiteral(
              `${(<{ text: string }>(<unknown>node.moduleSpecifier)).text}.js`
            );
            return typescript.updateImportDeclaration(
              node,
              node.decorators,
              node.modifiers,
              node.importClause,
              newModuleSpecifier
            );
          } else if (typescript.isExportDeclaration(node)) {
            const newModuleSpecifier = typescript.createLiteral(
              `${(<{ text: string }>(<unknown>node.moduleSpecifier)).text}.js`
            );
            return typescript.updateExportDeclaration(
              node,
              node.decorators,
              node.modifiers,
              node.exportClause,
              newModuleSpecifier,
              false
            );
          }
        }
        return typescript.visitEachChild(node, visitor, context);
      }

      return typescript.visitNode(node, visitor);
    };
  }

  return importTransformer;
}

const tsConfig = ts.createProject("tsconfig.json", {
  sourceMap: true,
  getCustomTransformers: () => ({
    after: [createTransformer()],
  }),
});

/********************/
/*		BUILD		*/
/********************/

/**
 * Build Compendiums
 */
function buildPack() {
  const packFolders = fs
    .readdirSync("src/packs/")
    .filter(function (file: string) {
      return fs.statSync(path.join("src/packs", file)).isDirectory();
    });
  function makeId(length: number) {
    let result = "";
    const characters =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  const packs = packFolders.map(function (folder: string) {
    return gulp
      .src(path.join("src/packs/", folder, "/**/*.yml"))
      .pipe(
        through2.obj(
          (
            file: { contents: Buffer | Uint8Array },
            enc: unknown,
            cb: (arg0: any, arg1: { contents: Buffer | Uint8Array }) => void
          ) => {
            file.contents = Buffer.concat([
              Buffer.from(`_id: ${makeId(16)}\n`),
              file.contents,
            ]);
            cb(null, file);
          }
        )
      )
      .pipe(gyaml({ space: 0, safe: true, json: true }))
      .pipe(concat(folder + ".json"))
      .pipe(rename(folder + ".db"))
      .pipe(gulp.dest("dist/packs"));
  });
  return mergeStream.call(null, packs);
}

/**
 * Build TypeScript
 */
function buildTS() {
  let src = gulp.src("src/**/*.ts");
  let processed = src
    .pipe(sourcemaps.init())
    .pipe(tsConfig())
    .pipe(sourcemaps.write(".", { sourceRoot: ".", includeContent: false }))
    .pipe(gulp.dest("dist"));
  let raw = src.pipe(gulp.dest("dist"));
    return mergeStream(raw, processed)
}

/**
 * Build list of entities
 */
async function buildEntities(cb: () => void) {
  glob("src/module/{actor,item}s/**/*.ts", (e, fileNames) => {
    const imports = [];
    const adds = [];
    fileNames
      .map((e) => {
        const filePath = path.posix.relative("./src/module", "./" + e);
        const name = path.basename(e, ".ts");
        const type = filePath.split("/")[0];
        return {
          name: name,
          relative: path.dirname(filePath),
          type: type.charAt(0).toUpperCase() + type.slice(1, -1),
          sheet: name.endsWith("-sheet"),
          hashedName: "_" + createHash("md4").update(e).digest("hex"),
        };
      })
      .forEach((e) => {
        imports.push(
          `import * as ${e.hashedName} from './${e.relative}/${e.name}'`
        );
        adds.push(
          e.sheet
            ? `${e.type}s.registerSheet("swnr", ${e.hashedName}.sheet, { makeDefault: true, types: ${e.hashedName}.types });`
            : `${e.type.toLowerCase()}s[${e.hashedName}.name] = ${
                e.hashedName
              }.entity as typeof ${e.type}`
        );
      });
    const mids = [
      "//This file is auto generated, leave it alone!",
      "import proxy from './proxy'",
      "const items = <Record<string, typeof Item>>{}",
      "const actors = <Record<string, typeof Actor>>{}",
    ];
    const ends = [
      "export const SWNRItem = proxy(items, Item) as typeof Item",
      "export const SWNRActor = proxy(actors, Actor) as typeof Actor",
      "",
    ];
    const out = imports.concat(mids, adds, ends).join("\n");
    // console.log(out);
    fs.writeFile("src/module/entities.ts", out, cb);
  });
}

/**
 * Build YAML to json
 */
function buildYaml() {
  return gulp
    .src(["src/**/*.yml", "!src/packs/**/*.yml"])
    .pipe(gyaml({ space: 2, safe: true }))
    .pipe(gulp.dest("dist"));
}
/**
 * Build Less
 */
function buildLess() {
  return gulp.src("src/**/*.less").pipe(less()).pipe(gulp.dest("dist"));
}
/**
 * Build template list
 */
function buildTemplateList() {
  const data = getManifest();
  return gulp
    .src("src/**/*.html")
    .pipe(
      rename(function (path: { dirname: string }) {
        path.dirname =
          `${data.name.split(".")[0]}s/${data.file.name}/` + path.dirname;
      })
    )
    .pipe(filelist("templates.json", { relative: true }))
    .pipe(gulp.dest("dist"));
}

/**
 * Build SASS
 */
function buildSASS() {
  return gulp
    .src("src/*.scss")
    .pipe(gulp.dest("dist"))
    .pipe(sourcemaps.init())
    .pipe(sass().on("error", sass.logError))
    .pipe(sourcemaps.write(".", { sourceRoot: ".", includeContent: false }))
    .pipe(gulp.dest("dist"));
}

/**
 * Copy static files
 */
async function copyFiles() {
  const statics = ["fonts", "assets", "templates"];
  try {
    for (const file of statics) {
      if (fs.existsSync(path.join("src", file))) {
        await fs.copy(path.join("src", file), path.join("dist", file));
      }
    }
    return Promise.resolve();
  } catch (err) {
    Promise.reject(err);
  }
}

/**
 * Watch for changes for each build step
 */
function buildWatch() {
  gulp.watch("src/module/{actor,item}s/**/*.ts", { ignoreInitial: false }, buildEntities);
  gulp.watch("src/**/*.ts", { ignoreInitial: false }, buildTS);
  gulp.watch("src/**/*.less", { ignoreInitial: false }, buildLess);
  gulp.watch("src/**/*.scss", { ignoreInitial: false }, buildSASS);
  gulp.watch(
    ["src/**/*.yml", "!src/packs/**/*.yml"],
    { ignoreInitial: false },
    buildYaml
  );
  gulp.watch("src/packs/**/*.yml", { ignoreInitial: false }, buildPack);
  gulp.watch(
    ["src/fonts", "src/templates", "src/sound"],
    { ignoreInitial: false },
    copyFiles
  );
  gulp.watch("src/**/*.html", { ignoreInitial: false }, buildTemplateList);
}

/********************/
/*		CLEAN		*/
/********************/

/**
 * Remove built files from `dist` folder
 * while ignoring source files
 */
async function clean() {
  const name = getManifest().file.name;
  const files = [];

  // If the project uses TypeScript
  if (fs.existsSync(path.join("src", `${name}.ts`))) {
    files.push(
      "lang",
      "templates",
      "assets",
      "module",
      `${name}.js`,
      `${name}.js.map`,
      `${name}.ts`,
      "module.json",
      "packs",
      "system.json",
      "template.json",
      "templates.json"
    );
  }

  // If the project uses Less or SASS
  if (
    fs.existsSync(path.join("src", `${name}.less`)) ||
    fs.existsSync(path.join("src", `${name}.scss`))
  ) {
    files.push(
      "fonts",
      `${name}.css`,
      `${name}.css.map`,
      `${name}.scss`,
      `${name}.less`
    );
  }

  console.log(" ", chalk.yellow("Files to clean:"));
  console.log("   ", chalk.blueBright(files.join("\n    ")));

  // Attempt to remove the files
  try {
    for (const filePath of files) {
      await fs.remove(path.join("dist", filePath));
    }
    return Promise.resolve();
  } catch (err) {
    Promise.reject(err);
  }
}

/********************/
/*		LINK		*/
/********************/

/**
 * Link build to User Data folder
 */
async function linkUserData() {
  const name = (<{ name: string }>getManifest().file).name;
  const config = getConfig();

  let destDir: string;
  try {
    if (
      fs.existsSync(path.resolve(".", "dist", "module.yml")) ||
      fs.existsSync(path.resolve(".", "src", "module.yml"))
    ) {
      destDir = "modules";
    } else if (
      fs.existsSync(path.resolve(".", "dist", "system.yml")) ||
      fs.existsSync(path.resolve(".", "src", "system.yml"))
    ) {
      destDir = "systems";
    } else {
      throw Error(
        `Could not find ${chalk.blueBright("module.yml")} or ${chalk.blueBright(
          "system.yml"
        )}`
      );
    }

    let linkDir: string;
    if (config.dataPath) {
      if (!fs.existsSync(path.join(config.dataPath, "Data")))
        throw Error("User Data path invalid, no Data directory found");

      linkDir = path.join(config.dataPath, "Data", destDir, name);
    } else {
      throw Error("No User Data path defined in foundryconfig.json");
    }

    if (argv.clean || argv.c) {
      console.log(
        chalk.yellow(`Removing build in ${chalk.blueBright(linkDir)}`)
      );

      await fs.remove(linkDir);
    } else if (!fs.existsSync(linkDir)) {
      console.log(chalk.green(`Copying build to ${chalk.blueBright(linkDir)}`));
      await fs.symlink(
        path.resolve("./dist"),
        linkDir,
        os.platform() === "win32" ? "junction" : null
      );
    }
    return Promise.resolve();
  } catch (err) {
    Promise.reject(err);
  }
}

/*********************/
/*		PACKAGE		 */
/*********************/

/**
 * Package build
 */
async function packageBuild() {
  const manifest = getManifest();

  return new Promise((resolve, reject) => {
    try {
      // Remove the package dir without doing anything else
      if (argv.clean || argv.c) {
        console.log(chalk.yellow("Removing all packaged files"));
        fs.removeSync("package");
        return;
      }

      // Ensure there is a directory to hold all the packaged versions
      fs.ensureDirSync("package");

      // Initialize the zip file
      const zipName = `${manifest.file.name}-v${manifest.file.version}.zip`;
      const zipFile = fs.createWriteStream(path.join("package", zipName));
      const zip = archiver("zip", { zlib: { level: 9 } });

      zipFile.on("close", () => {
        console.log(chalk.green(zip.pointer() + " total bytes"));
        console.log(chalk.green(`Zip file ${zipName} has been written`));
        return resolve();
      });

      zip.on("error", (err: unknown) => {
        throw err;
      });

      zip.pipe(zipFile);

      // Add the directory with the final code
      zip.directory("dist/", (<{ name: string }>manifest.file).name);

      zip.finalize();
    } catch (err) {
      return reject(err);
    }
  });
}

const execBuild = gulp.parallel(
  gulp.series(buildEntities, buildTS),
  buildLess,
  buildSASS,
  buildYaml,
  copyFiles,
  buildTemplateList,
  buildPack
);

exports.build = gulp.series(clean, execBuild);
exports.watch = buildWatch;
exports.clean = clean;
exports.link = linkUserData;
exports.package = packageBuild;
exports.buildTemplateList = buildTemplateList;
