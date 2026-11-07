# pim, compiled the same way as `bun run install:user`, with its agent skills
# in share/pim/skills/<skill>/SKILL.md.
#
# The node_modules hash below changes whenever bun.lock or the Bun version
# changes. Then `nix build .#default` fails and prints the expected value
# after "got:"; put that value in outputHash.
{
  bun,
  lastModifiedDate,
  lib,
  stdenvNoCC,
}:
let
  pname = "pim";
  # pim has no releases, so the version is the date of the commit, taken from
  # the flake's lastModifiedDate (YYYYMMDDHHMMSS).
  datePart = start: length: builtins.substring start length lastModifiedDate;
  version = "0-unstable-${datePart 0 4}-${datePart 4 2}-${datePart 6 2}";
  # The repository without dependencies, build output, and local state, which a
  # dirty checkout or a path: flake would otherwise copy into the store.
  # lib.fileset can't exclude a directory by name at any depth, so this filters
  # the source by name instead.
  src = lib.cleanSourceWith {
    src = lib.cleanSource ../.;
    filter =
      path: _type:
      !builtins.elem (baseNameOf path) [
        ".direnv"
        ".turbo"
        "dist"
        "node_modules"
        "result"
      ];
  };
  skills = builtins.attrNames (
    lib.filterAttrs (_name: type: type == "directory") (builtins.readDir ../apps/cli/skills)
  );
  # The CLI's runtime dependencies only; the compiled binary bundles them.
  # The name holds Bun's version and a digest of bun.lock, so a change to either
  # installs them again and fails on a stale hash instead of silently reusing
  # the old dependencies.
  lockDigest = builtins.substring 0 12 (builtins.hashFile "sha256" ../bun.lock);
  nodeModules = stdenvNoCC.mkDerivation {
    name = "${pname}-node-modules-bun-${bun.version}-${lockDigest}";
    inherit src;
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      bun install --frozen-lockfile --production --ignore-scripts --no-progress
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir "$out"
      find . -type d -name node_modules -prune -print0 | tar --null --files-from=- -cf - | tar -C "$out" -xf -
      runHook postInstall
    '';
    dontFixup = true;
    outputHash = "sha256-iGa8LuovMWpjs+jSQVxOmThElNw4nIXc6KoL1bS/QKA=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    impureEnvVars = lib.fetchers.proxyImpureEnvVars;
  };
in
stdenvNoCC.mkDerivation {
  inherit pname version src;
  nativeBuildInputs = [ bun ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    cp -r --no-preserve=mode ${nodeModules}/. .
    cd apps/cli
    bun build --compile src/app/cli.ts --outfile dist/pim
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 dist/pim "$out/bin/pim"
    for skill in ${lib.escapeShellArgs skills}; do
      install -Dm444 "skills/$skill/SKILL.md" "$out/share/pim/skills/$skill/SKILL.md"
    done
    runHook postInstall
  '';
  # Bun appends the bundled program to its own executable; leave it intact.
  dontStrip = true;
  dontPatchELF = true;

  passthru = { inherit nodeModules skills; };
  meta = {
    description = "Command line interface for mail, calendars, and contacts";
    homepage = "https://github.com/davidvornholt/pim";
    license = lib.licenses.mit;
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
    ];
    mainProgram = "pim";
  };
}
