import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = {
  directory: "audit",
  name: "@pegma/audit",
};
const REPOSITORY_URL = "git+https://github.com/pegma-dev/audit.git";
const REVIEWED_PNPM_VERSION = "10.34.5";
const REVIEWED_NPM_VERSION = "11.18.0";
/**
 * Subresource integrity of the reviewed npm CLI tarball.
 *
 * The CLI that packs and publishes the release is itself fetched from the
 * registry at release time, so pinning only its version leaves the bytes to
 * whatever the registry serves. Everything downstream is verified with
 * metadata this same tool produced, which a trojaned CLI would produce
 * consistently. Recorded from `npm view npm@11.18.0 dist.integrity`.
 */
const REVIEWED_NPM_INTEGRITY =
  "sha512-T67M4L5wNm0cZ7EBLErcEkY1SmzEW/WJ+SADBzsFUY1UdAPfFHXFQtZ6SEXiK0+vzXysCvAsepbMaBTwnrAD+w==";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
/**
 * Lifecycle scripts npm runs on a consumer's machine during `npm install`.
 *
 * `package.json` is always packed, so the `files` allowlist places no
 * constraint on these: one of them in the published manifest is arbitrary code
 * execution on every downstream host. Build-time hooks such as `prepack` run
 * here instead, where they belong.
 */
const INSTALL_TIME_SCRIPTS = ["preinstall", "install", "postinstall"];

export const RELEASE_PACKAGES = [PACKAGE];

/** Workspace package manager pinned in package.json via Corepack. */
export const REVIEWED_PNPM = {
  version: REVIEWED_PNPM_VERSION,
};

/** What the release workflow must install, so a test can hold it to this. */
export const REVIEWED_NPM = {
  version: REVIEWED_NPM_VERSION,
  integrity: REVIEWED_NPM_INTEGRITY,
};

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

function isNpmCliPath(execPath) {
  // `pnpm run` sets npm_execpath to .../pnpm.cjs. Never treat that, or an
  // npm-cli.js nested under a pnpm install, as the reviewed npm CLI.
  if (/pnpm/i.test(execPath)) return false;
  return basename(execPath).toLowerCase() === "npm-cli.js";
}

function npmCliBeside(nodeOrBinDirectory) {
  return [
    join(
      nodeOrBinDirectory,
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    join(nodeOrBinDirectory, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeOrBinDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

export function resolveNpmCli() {
  const execPath = process.env.npm_execpath;
  if (execPath !== undefined && isNpmCliPath(execPath)) {
    return execPath;
  }
  // `pnpm run` sets npm_execpath to pnpm. Pack, publish, and registry
  // lookups still use the reviewed npm CLI, resolved without a shell.
  const candidates = npmCliBeside(dirname(process.execPath));
  const pathEnv = process.env.PATH ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const directory of pathEnv.split(delimiter)) {
    if (directory !== "") candidates.push(...npmCliBeside(directory));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  fail(
    "could not resolve the npm CLI used to pack and publish; Node's bundled npm is required",
  );
}

function runWorkspace(arguments_, options = {}) {
  const execPath = process.env.npm_execpath;
  if (execPath === undefined) {
    fail(
      "release commands must be run through a package manager script (npm_execpath is not set); use pnpm run release:check, release:pack, or release:publish",
    );
  }
  return run(process.execPath, [execPath, ...arguments_], options);
}

function runNpm(arguments_, options = {}) {
  return run(process.execPath, [resolveNpmCli(), ...arguments_], options);
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function hashTarball(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

/**
 * Confirms a downloaded npm CLI tarball is the reviewed one, before it is
 * installed and used to build the release.
 */
export function verifyReviewedNpmTarball(bytes) {
  const { integrity } = hashTarball(bytes);
  if (!safeEqual(integrity, REVIEWED_NPM_INTEGRITY)) {
    fail(
      `npm@${REVIEWED_NPM_VERSION} tarball integrity ${integrity} does not match the reviewed ${REVIEWED_NPM_INTEGRITY}`,
    );
  }
  return integrity;
}

/** The install-time lifecycle script a manifest defines, or null. */
export function findInstallTimeScript(scripts) {
  if (scripts === null || typeof scripts !== "object") return null;
  return (
    INSTALL_TIME_SCRIPTS.find((name) => scripts[name] !== undefined) ?? null
  );
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

export function validateReleaseTag(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag === undefined || !/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
    fail("a stable release tag is required");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit)
  ) {
    fail("an exact release event commit is required");
  }

  const tagRef = `refs/tags/${releaseTag}`;
  const type = run(gitCommand(), ["cat-file", "-t", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (type.status !== 0 || type.stdout.trim() !== "tag") {
    fail("the release ref must be an annotated tag object");
  }
  const headCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const tagCommit = run(gitCommand(), ["rev-parse", `${tagRef}^{commit}`], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(headCommit, tagCommit) ||
    !safeEqual(headCommit, expectedReleaseCommit)
  ) {
    fail(
      "the release checkout, signed tag target, and release event commit must match",
    );
  }
  const signature = run(gitCommand(), ["verify-tag", "--raw", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("the release tag signature is not valid for an approved signer");
  }
  const onMain = run(
    gitCommand(),
    ["merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"],
    { cwd: root, capture: true, allowFailure: true },
  );
  if (onMain.status !== 0) {
    fail("the release tag commit must be contained in origin/main");
  }
  return { headCommit, releaseTag };
}

export function lockfileImporterBlock(lockfile, importer) {
  const heading = `  ${importer}:`;
  const lines = lockfile.split("\n");
  const start = lines.findIndex((line) => line === heading);
  if (start === -1) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/u.test(line) || /^[^\s]/u.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

export function unquoteYamlScalar(raw) {
  if (
    raw.length >= 2 &&
    ((raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"')))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

export function parseImporterDependencyPins(block) {
  const pins = {};
  const pattern =
    /^ {6}('[^']+'|"[^"]+"|[A-Za-z0-9@/._-]+):\n {8}specifier: (\S+)\n {8}version: (\S+)$/gmu;
  for (const match of block.matchAll(pattern)) {
    pins[unquoteYamlScalar(match[1])] = {
      specifier: unquoteYamlScalar(match[2]),
      version: unquoteYamlScalar(match[3]),
    };
  }
  return pins;
}

function parseSemver(text) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/u.exec(
    text,
  );
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(left, right) {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

function lockResolvedVersion(version) {
  const paren = version.indexOf("(");
  return paren === -1 ? version : version.slice(0, paren);
}

function isRangeSpecifier(specifier) {
  return (
    specifier === "*" ||
    specifier === "x" ||
    specifier.startsWith("^") ||
    specifier.startsWith("~") ||
    /^(>=|>|<=|<|=)/u.test(specifier)
  );
}

function isPrereleaseVersion(version) {
  return /-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?:\+|$)/u.test(version);
}

export function resolvedVersionSatisfies(resolved, specifier) {
  const version = lockResolvedVersion(resolved);
  if (!isRangeSpecifier(specifier)) {
    return version === specifier;
  }
  if (specifier === "*" || specifier === "x") {
    return parseSemver(version) !== null && !isPrereleaseVersion(version);
  }
  const parsed = parseSemver(version);
  if (parsed === null || isPrereleaseVersion(version)) return false;
  const caret = /^\^((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/u.exec(
    specifier,
  );
  if (caret !== null) {
    const base = parseSemver(caret[1]);
    if (base === null || compareSemver(parsed, base) < 0) return false;
    if (base.major > 0) return parsed.major === base.major;
    if (base.minor > 0)
      return parsed.major === 0 && parsed.minor === base.minor;
    return (
      parsed.major === 0 && parsed.minor === 0 && parsed.patch === base.patch
    );
  }
  const tilde = /^~((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/u.exec(
    specifier,
  );
  if (tilde !== null) {
    const base = parseSemver(tilde[1]);
    return (
      base !== null &&
      compareSemver(parsed, base) >= 0 &&
      parsed.major === base.major &&
      parsed.minor === base.minor
    );
  }
  return false;
}

export function assertPnpmLockfileSynchronized(
  lockfile,
  importer,
  dependencies,
) {
  if (!/^lockfileVersion:/u.test(lockfile)) {
    fail("pnpm-lock.yaml is missing lockfileVersion");
  }
  const block = lockfileImporterBlock(lockfile, importer);
  if (block === null) {
    fail(`${importer} is missing from pnpm-lock.yaml`);
  }
  const pins = parseImporterDependencyPins(block);
  for (const [name, specifier] of Object.entries(dependencies)) {
    const entry = pins[name];
    if (
      entry === undefined ||
      entry.specifier !== specifier ||
      !resolvedVersionSatisfies(entry.version, specifier)
    ) {
      fail(
        `${name}@${specifier} is not synchronized with its own pnpm-lock.yaml entry`,
      );
    }
  }
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const rootManifest = await readJson(join(root, "package.json"));
  const packageDirectory = join(root, "packages", PACKAGE.directory);
  const manifest = await readJson(join(packageDirectory, "package.json"));
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");

  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== `pnpm@${REVIEWED_PNPM_VERSION}`
  ) {
    fail(`the private root must pin pnpm@${REVIEWED_PNPM_VERSION}`);
  }
  if (
    manifest.name !== PACKAGE.name ||
    !STABLE_SEMVER.test(manifest.version) ||
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.engines?.node !== ">=22" ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== `packages/${PACKAGE.directory}`
  ) {
    fail(`${PACKAGE.name} has invalid public package metadata`);
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => !entry.startsWith("dist/")) ||
    typeof manifest.scripts?.prepack !== "string" ||
    !manifest.scripts.prepack.includes("build")
  ) {
    fail(`${PACKAGE.name} has an unsafe package allowlist or prepack`);
  }
  const installScript = findInstallTimeScript(manifest.scripts);
  if (installScript !== null) {
    fail(
      `${PACKAGE.name} must not define the install-time script ${installScript}`,
    );
  }
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail(`${PACKAGE.name} exports must point into dist`);
  }
  await stat(join(packageDirectory, "README.md"));
  await stat(join(packageDirectory, "LICENSE"));
  assertPnpmLockfileSynchronized(
    lockfile,
    `packages/${PACKAGE.directory}`,
    manifest.dependencies ?? {},
  );

  const publicWorkspaces = [];
  for (const entry of await readdir(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    try {
      const workspace = await readJson(
        join(root, "packages", entry.name, "package.json"),
      );
      if (workspace.private !== true) publicWorkspaces.push(workspace.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (publicWorkspaces.length !== 1 || publicWorkspaces[0] !== PACKAGE.name) {
    fail("public workspace inventory does not match the reviewed release list");
  }

  if (options.requireClean) {
    const status = run(gitCommand(), ["status", "--porcelain"], {
      cwd: root,
      capture: true,
    }).stdout;
    if (status.trim() !== "")
      fail("release preparation requires a clean checkout");
  }
  if (options.requireMainAncestor) {
    const head = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    const onMain = run(
      gitCommand(),
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, capture: true, allowFailure: true },
    );
    if (onMain.status !== 0) {
      fail("release commit must be contained in origin/main");
    }
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined && releaseTag !== `v${manifest.version}`) {
    fail(`release tag must be v${manifest.version}`);
  }
  const prerelease =
    options.releasePrerelease ?? process.env.RELEASE_PRERELEASE ?? false;
  if (prerelease === true || prerelease === "true") {
    fail("prereleases cannot publish packages");
  }
  if (options.requireReleaseTag) {
    validateReleaseTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  return { root, manifest, packageDirectory, releaseTag };
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required))
      fail(`${manifest.name} is missing ${required}`);
  }
  if (
    paths.some(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !path.startsWith("dist/"),
    )
  ) {
    fail(`${manifest.name} tarball contains an unreviewed file`);
  }
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//u, "");
    if (!paths.includes(path)) fail(`${manifest.name} is missing ${path}`);
  }
}

async function smokeTestTarball(tarball, manifest) {
  const directory = await mkdtemp(join(tmpdir(), "audit-release-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"audit-release-smoke","private":true,"type":"module"}\n',
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      { cwd: directory, capture: true },
    );
    for (const key of Object.keys(manifest.exports)) {
      const specifier =
        key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`;
      run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(specifier)})`,
        ],
        { cwd: directory, capture: true },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareRelease(options = {}) {
  const { root, manifest, packageDirectory, releaseTag } =
    await validateRepository(options);
  const gitCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const output = resolve(root, options.output ?? ".release");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) {
    fail(`release output directory must be empty: ${output}`);
  }

  runWorkspace(["run", "build"], { cwd: root });
  const result = runNpm(
    ["pack", packageDirectory, "--json", "--pack-destination", output],
    { cwd: root, capture: true },
  );
  const [packed] = JSON.parse(result.stdout);
  if (
    packed?.name !== manifest.name ||
    packed?.version !== manifest.version ||
    typeof packed.filename !== "string" ||
    !Array.isArray(packed.files)
  ) {
    fail("npm pack returned invalid metadata");
  }
  verifyPackedFiles(manifest, packed.files);
  const tarballPath = join(output, basename(packed.filename));
  const hashes = hashTarball(await readFile(tarballPath));
  if (
    !safeEqual(hashes.integrity, packed.integrity) ||
    !safeEqual(hashes.shasum, packed.shasum)
  ) {
    fail("tarball hashes do not match npm pack metadata");
  }
  await smokeTestTarball(tarballPath, manifest);

  const prepared = {
    schemaVersion: 1,
    gitCommit,
    releaseTag: releaseTag ?? null,
    package: {
      name: manifest.name,
      version: manifest.version,
      tarball: basename(tarballPath),
      integrity: hashes.integrity,
      shasum: hashes.shasum,
      files: packed.files
        .map(({ path, size }) => ({ path, size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
  const manifestPath = join(output, "package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`);
  return { manifestPath, manifest: prepared };
}

function queryRegistryIntegrity(name, version) {
  const spec = `${name}@${version}`;
  const result = runNpm(["view", spec, "dist.integrity", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout);
    if (typeof integrity !== "string" || integrity.length === 0) {
      fail(`${spec} exists without dist.integrity`);
    }
    return integrity;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b/u.test(output)) return null;
  fail(`npm registry lookup failed for ${spec}:\n${output.trim()}`);
}

export function decidePublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === null) return "publish";
  if (safeEqual(localIntegrity, registryIntegrity)) return "skip";
  fail("the registry version exists with different tarball integrity");
}

function requireTrustedPublishingNpm() {
  const version = runNpm(["--version"], { capture: true }).stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (match === null) fail(`could not parse npm version ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (
    major < 11 ||
    (major === 11 && minor < 5) ||
    (major === 11 && minor === 5 && patch < 1)
  ) {
    fail("trusted publishing requires npm 11.5.1 or newer");
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function confirmRegistryIntegrity(record) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const integrity = queryRegistryIntegrity(record.name, record.version);
    if (integrity !== null && safeEqual(record.integrity, integrity)) return;
    if (attempt < 5) wait(2 ** attempt * 1000);
  }
  fail(
    `${record.name}@${record.version} did not expose the prepared integrity`,
  );
}

async function verifyPreparedManifest(path) {
  const prepared = await readJson(path);
  const record = prepared.package;
  if (
    prepared.schemaVersion !== 1 ||
    !/^[0-9a-f]{40,64}$/u.test(prepared.gitCommit) ||
    prepared.releaseTag !== `v${record?.version}` ||
    record?.name !== PACKAGE.name ||
    !STABLE_SEMVER.test(record.version) ||
    typeof record.integrity !== "string" ||
    typeof record.shasum !== "string" ||
    !Array.isArray(record.files)
  ) {
    fail("prepared package manifest is invalid");
  }
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: defaultRoot(),
    capture: true,
  }).stdout.trim();
  if (!safeEqual(currentCommit, prepared.gitCommit)) {
    fail("prepared package manifest commit does not match the checkout");
  }
  const expectedTarball = `${PACKAGE.name
    .slice(1)
    .replace("/", "-")}-${record.version}.tgz`;
  if (record.tarball !== expectedTarball)
    fail("prepared tarball name is invalid");
  const tarball = resolve(dirname(path), record.tarball);
  if (dirname(tarball) !== resolve(dirname(path))) {
    fail("prepared tarball must be beside the package manifest");
  }
  const hashes = hashTarball(await readFile(tarball));
  if (
    !safeEqual(hashes.integrity, record.integrity) ||
    !safeEqual(hashes.shasum, record.shasum)
  ) {
    fail("prepared tarball has changed");
  }
  return prepared;
}

export async function publishPreparedRelease(options = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "release"
  ) {
    fail("release:publish is restricted to a GitHub release workflow");
  }
  requireTrustedPublishingNpm();
  const path = resolve(options.manifest ?? ".release/package-manifest.json");
  const prepared = await verifyPreparedManifest(path);
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag !== prepared.releaseTag) {
    fail("prepared manifest must match the release tag");
  }
  if (
    expectedCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedCommit) ||
    !safeEqual(expectedCommit, prepared.gitCommit)
  ) {
    fail("prepared package manifest must match the release event commit");
  }

  const record = prepared.package;
  const decision = decidePublication(
    record.integrity,
    queryRegistryIntegrity(record.name, record.version),
  );
  if (decision === "skip") {
    process.stdout.write(
      `Verified existing ${record.name}@${record.version}; skipping.\n`,
    );
    return;
  }
  runNpm(
    [
      "publish",
      resolve(dirname(path), record.tarball),
      "--access",
      "public",
      "--provenance",
    ],
    { cwd: dirname(path) },
  );
  confirmRegistryIntegrity(record);
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--require-main-ancestor") {
      options.requireMainAncestor = true;
      continue;
    }
    if (argument === "--require-clean") {
      options.requireClean = true;
      continue;
    }
    if (argument === "--require-release-tag") {
      options.requireReleaseTag = true;
      continue;
    }
    const key =
      argument === "--root"
        ? "root"
        : argument === "--output"
          ? "output"
          : argument === "--manifest"
            ? "manifest"
            : argument === "--tarball"
              ? "tarball"
              : argument === "--expected-release-commit"
                ? "expectedReleaseCommit"
                : null;
    if (key === null || arguments_[index + 1] === undefined) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "verify-npm") {
    if (options.tarball === undefined) fail("--tarball is required");
    verifyReviewedNpmTarball(await readFile(resolve(options.tarball)));
    process.stdout.write(
      `Verified the reviewed npm@${REVIEWED_NPM_VERSION} tarball.\n`,
    );
    return;
  }
  if (command === "check") {
    await validateRepository(options);
    process.stdout.write("Release metadata is valid.\n");
    return;
  }
  if (command === "pack") {
    const { manifestPath } = await prepareRelease(options);
    process.stdout.write(`Prepared release package at ${manifestPath}.\n`);
    return;
  }
  if (command === "publish") {
    await publishPreparedRelease(options);
    return;
  }
  fail("usage: release-packages.mjs <check|pack|publish|verify-npm> [options]");
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
