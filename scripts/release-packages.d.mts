export interface ReleasePackageDefinition {
  readonly directory: string;
  readonly name: string;
}

export interface ValidationOptions {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly releasePrerelease?: boolean | string;
  readonly expectedReleaseCommit?: string;
  readonly requireClean?: boolean;
  readonly requireMainAncestor?: boolean;
  readonly requireReleaseTag?: boolean;
}

export interface ReleaseCommandOptions extends ValidationOptions {
  readonly manifest?: string;
  readonly output?: string;
  readonly tarball?: string;
}

export interface PublicPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly publishConfig?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface PreparedReleaseManifest {
  readonly schemaVersion: 1;
  readonly gitCommit: string;
  readonly releaseTag: string | null;
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly tarball: string;
    readonly integrity: string;
    readonly sha256: string;
    readonly shasum: string;
    readonly files: readonly { readonly path: string; readonly size: number }[];
  };
}

export interface ValidationResult {
  readonly root: string;
  readonly manifest: PublicPackageManifest;
  readonly packageDirectory: string;
  readonly releaseTag: string | undefined;
}

export const RELEASE_PACKAGES: readonly ReleasePackageDefinition[];

export const REVIEWED_PNPM: {
  readonly version: string;
};

export const REVIEWED_NPM: {
  readonly version: string;
  readonly integrity: string;
};

export function resolveNpmCli(): string;

export function lockfileImporterBlock(
  lockfile: string,
  importer: string,
): string | null;

export function unquoteYamlScalar(raw: string): string;

export function parseImporterDependencyPins(block: string): {
  readonly [name: string]: {
    readonly specifier: string;
    readonly version: string;
  };
};

export function resolvedVersionSatisfies(
  resolved: string,
  specifier: string,
): boolean;

export function assertPnpmLockfileSynchronized(
  lockfile: string,
  importer: string,
  dependencies: { readonly [name: string]: string },
): void;

export function findInstallTimeScript(
  scripts: unknown,
): "preinstall" | "install" | "postinstall" | null;

export function verifyReviewedNpmTarball(bytes: Uint8Array | string): string;

export function validatePackageManifest(
  manifest: PublicPackageManifest,
  options?: {
    readonly label?: string;
    readonly expectedName?: string;
    readonly expectedVersion?: string;
  },
): PublicPackageManifest;

export function comparePackedManifest(
  source: PublicPackageManifest,
  packed: PublicPackageManifest,
): void;

export function validateReleaseInventory(
  directory: string,
  expectedTarball: string,
): Promise<void>;

export function parseArguments(
  arguments_: readonly string[],
): ReleaseCommandOptions;

export function validateRepository(
  options?: ValidationOptions,
): Promise<ValidationResult>;

export function validateReleaseTag(options?: {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly expectedReleaseCommit?: string;
}): { headCommit: string; releaseTag: string };

export function decidePublication(
  localIntegrity: string,
  registryIntegrity: string | null,
): "publish" | "skip";

export function prepareRelease(
  options?: ReleaseCommandOptions,
): Promise<{ manifestPath: string; manifest: PreparedReleaseManifest }>;

export function publishPreparedRelease(
  options?: ReleaseCommandOptions,
): Promise<void>;
