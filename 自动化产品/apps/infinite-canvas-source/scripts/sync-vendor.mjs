import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(scriptDir, "..");
const outDir = resolve(sourceDir, "out");
const vendorRoot = resolve(sourceDir, "..", "..", "vendor");
const targetDir = resolve(vendorRoot, "infinite-canvas");
const stageDir = resolve(vendorRoot, ".infinite-canvas-stage");
const previousDir = resolve(vendorRoot, ".infinite-canvas-previous");
const manifestPath = resolve(vendorRoot, "infinite-canvas.manifest.json");
const manifestTempPath = resolve(vendorRoot, ".infinite-canvas.manifest.tmp");
const previousManifestPath = resolve(vendorRoot, ".infinite-canvas.manifest.previous");
const checkOnly = process.argv.includes("--check");

function assertManagedPath(path, expected) {
  if (path !== expected || !path.startsWith(`${vendorRoot}${sep}`)) {
    throw new Error(`拒绝操作未验证路径：${path}`);
  }
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`静态闭包不允许符号链接：${relative(root, absolute)}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  return files;
}

async function describeClosure(root) {
  const files = await listFiles(root);
  const described = [];
  let totalBytes = 0;
  for (const path of files) {
    const absolute = resolve(root, ...path.split("/"));
    const metadata = await stat(absolute);
    const content = await readFile(absolute);
    totalBytes += metadata.size;
    described.push({
      path,
      size: metadata.size,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return {
    schemaVersion: 1,
    basePath: "/XZ-Design",
    fileCount: described.length,
    totalBytes,
    files: described,
  };
}

function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function assertDirectory(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label}不存在或不是普通目录：${path}`);
  }
}

async function verify(sourceManifest) {
  await assertDirectory(targetDir, "vendor 闭包");
  const targetManifest = await describeClosure(targetDir);
  if (serialize(targetManifest) !== serialize(sourceManifest)) {
    throw new Error("vendor 闭包与本次 out 构建不一致");
  }
  const storedManifest = await readFile(manifestPath, "utf8").catch(() => "");
  if (storedManifest !== serialize(sourceManifest)) {
    throw new Error("vendor manifest 缺失或与闭包不一致");
  }
}

async function sync(sourceManifest) {
  assertManagedPath(targetDir, resolve(vendorRoot, "infinite-canvas"));
  assertManagedPath(stageDir, resolve(vendorRoot, ".infinite-canvas-stage"));
  assertManagedPath(previousDir, resolve(vendorRoot, ".infinite-canvas-previous"));
  assertManagedPath(manifestTempPath, resolve(vendorRoot, ".infinite-canvas.manifest.tmp"));
  assertManagedPath(previousManifestPath, resolve(vendorRoot, ".infinite-canvas.manifest.previous"));

  await rm(stageDir, { recursive: true, force: true });
  await rm(previousDir, { recursive: true, force: true });
  await rm(manifestTempPath, { force: true });
  await rm(previousManifestPath, { force: true });
  await mkdir(vendorRoot, { recursive: true });
  await cp(outDir, stageDir, { recursive: true, errorOnExist: true });

  const stagedManifest = await describeClosure(stageDir);
  if (serialize(stagedManifest) !== serialize(sourceManifest)) {
    throw new Error("临时静态闭包复制校验失败");
  }
  await writeFile(manifestTempPath, serialize(sourceManifest), "utf8");

  let movedPrevious = false;
  let movedPreviousManifest = false;
  let promotedTarget = false;
  let promotedManifest = false;
  try {
    const targetMetadata = await lstat(targetDir).catch(() => null);
    if (targetMetadata) {
      if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) {
        throw new Error(`目标不是普通目录：${targetDir}`);
      }
      await rename(targetDir, previousDir);
      movedPrevious = true;
    }
    const manifestMetadata = await lstat(manifestPath).catch(() => null);
    if (manifestMetadata) {
      if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
        throw new Error(`manifest 不是普通文件：${manifestPath}`);
      }
      await rename(manifestPath, previousManifestPath);
      movedPreviousManifest = true;
    }
    await rename(stageDir, targetDir);
    promotedTarget = true;
    await rename(manifestTempPath, manifestPath);
    promotedManifest = true;
    await verify(sourceManifest);
  } catch (error) {
    if (promotedTarget) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (movedPrevious) {
      await rename(previousDir, targetDir).catch(() => undefined);
    }
    if (promotedManifest) {
      await rm(manifestPath, { force: true }).catch(() => undefined);
    }
    if (movedPreviousManifest) {
      await rename(previousManifestPath, manifestPath).catch(() => undefined);
    }
    throw error;
  }

  await rm(previousDir, { recursive: true, force: true });
  await rm(previousManifestPath, { force: true });
}

await assertDirectory(outDir, "Next 静态输出 out");
const sourceManifest = await describeClosure(outDir);
if (sourceManifest.fileCount === 0) {
  throw new Error("拒绝同步空静态闭包");
}

if (checkOnly) {
  await verify(sourceManifest);
  console.log(`vendor 闭包校验通过：${sourceManifest.fileCount} files, ${sourceManifest.totalBytes} bytes`);
} else {
  await sync(sourceManifest);
  console.log(`vendor 闭包已审计同步：${sourceManifest.fileCount} files, ${sourceManifest.totalBytes} bytes`);
}
