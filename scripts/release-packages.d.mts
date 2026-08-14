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
  readonly [key: string]: unknown;
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

export function parseImporterDependencyPins(block: string): {
  readonly [name: string]: {
    readonly specifier: string;
    readonly version: string;
  };
};

export function assertPnpmLockfileSynchronized(
  lockfile: string,
  importer: string,
  dependencies: { readonly [name: string]: string },
): void;

export function findInstallTimeScript(
  scripts: unknown,
): "preinstall" | "install" | "postinstall" | null;

export function verifyReviewedNpmTarball(bytes: Uint8Array | string): string;

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
): Promise<{ manifestPath: string; manifest: unknown }>;

export function publishPreparedRelease(
  options?: ReleaseCommandOptions,
): Promise<void>;
