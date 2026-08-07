declare module "semver" {
  type Options = { includePrerelease?: boolean };

  const semver: {
    valid(version: string, options?: Options): string | null;
    validRange(range: string, options?: Options): string | null;
    minVersion(range: string, options?: Options): { version: string } | null;
    gt(version1: string, version2: string, options?: Options): boolean;
    prerelease(version: string, options?: Options): ReadonlyArray<string | number> | null;
    satisfies(version: string, range: string, options?: Options): boolean;
  };

  export = semver;
}
