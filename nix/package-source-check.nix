# Fails when the package source keeps a path that git ignores or drops one that
# git keeps. It asks `git check-ignore` about every path in the repository and
# about a sample path for each .gitignore pattern, such as
# .env.local.standards-x.tmp for `.env.local.standards-*.tmp`.
{
  git,
  lib,
  runCommand,
  src,
}:
let
  rootString = toString src.origSrc;
  join = dir: name: if dir == "" then name else "${dir}/${name}";
  keepsPath = relative: type: src.filter "${rootString}/${relative}" type;

  # Every path in the root, as { relative; type; }, except below a directory
  # the source drops, which would take long for node_modules.
  existingPaths =
    let
      walk =
        dir:
        lib.concatLists (
          lib.mapAttrsToList (
            name: type:
            let
              relative = join dir name;
            in
            [ { inherit relative type; } ]
            ++ lib.optionals (type == "directory" && keepsPath relative type) (walk relative)
          ) (builtins.readDir (if dir == "" then rootString else "${rootString}/${dir}"))
        );
    in
    # lib.cleanSource also drops .git and editor backups, which git never ignores.
    lib.filter ({ relative, type }: lib.cleanSourceFilter "${rootString}/${relative}" type) (walk "");

  # A path that each .gitignore pattern matches, also one directory deeper for
  # a pattern that applies at any depth. Patterns with character classes or
  # escapes are left out.
  patternSamples =
    lib.concatMap
      (
        { relative, ... }:
        let
          base = dirOf relative;
          lines = lib.splitString "\n" (builtins.readFile "${rootString}/${relative}");
          usable = line: builtins.match "(#.*|[[:space:]]*|.*[][\\\\].*)" line == null;
          sample =
            line:
            let
              pattern = lib.removePrefix "!" line;
              directory = lib.hasSuffix "/" pattern;
              trimmed = lib.removePrefix "/" (lib.removeSuffix "/" pattern);
              name =
                builtins.replaceStrings
                  [
                    "**/"
                    "**"
                    "*"
                    "?"
                  ]
                  [
                    ""
                    "x"
                    "x"
                    "x"
                  ]
                  trimmed;
              anchored = lib.hasPrefix "/" pattern || lib.hasInfix "/" trimmed;
              at = prefix: {
                relative = join (if base == "." then "" else base) (prefix + name);
                type = if directory then "directory" else "regular";
              };
            in
            [ (at "") ] ++ lib.optional (!anchored) (at "sample-directory/");
        in
        lib.concatMap sample (lib.filter usable lines)
      )
      (
        lib.filter (
          { relative, type }:
          type == "regular" && baseNameOf relative == ".gitignore" && keepsPath relative type
        ) existingPaths
      );

  # Whether the source keeps a path that may not exist, which needs every
  # directory above it kept as well.
  keepsWithParents =
    { relative, type }:
    let
      parts = lib.splitString "/" relative;
      parents = lib.genList (count: lib.concatStringsSep "/" (lib.take (count + 1) parts)) (
        lib.length parts - 1
      );
    in
    lib.all (parent: keepsPath parent "directory") parents && keepsPath relative type;

  # One sample per path; for a path that exists, the type it has.
  samples = lib.attrValues (
    builtins.listToAttrs (
      map (sample: {
        name = sample.relative;
        value = sample;
      }) (existingPaths ++ patternSamples)
    )
  );
  lineFile = name: paths: builtins.toFile name (lib.concatMapStrings (path: path + "\n") paths);
in
runCommand "package-source-check"
  {
    nativeBuildInputs = [ git ];
    directories = lineFile "directories" (
      map (sample: sample.relative) (lib.filter (sample: sample.type == "directory") samples)
    );
    files = lineFile "files" (
      map (sample: sample.relative) (lib.filter (sample: sample.type != "directory") samples)
    );
    all = lineFile "all" (map (sample: sample.relative) samples);
    dropped = lineFile "dropped" (
      map (sample: sample.relative) (lib.filter (sample: !keepsWithParents sample) samples)
    );
  }
  ''
    export HOME=$TMPDIR GIT_CONFIG_NOSYSTEM=1
    mkdir tree
    cd tree
    git init --quiet
    # git matches a pattern that ends in a slash only against a directory it
    # can see, so each directory gets a file.
    while IFS= read -r path; do
      mkdir -p -- "$path"
      touch -- "$path/.sample"
    done < "$directories"
    while IFS= read -r path; do
      mkdir -p -- "$(dirname -- "$path")"
      touch -- "$path"
    done < "$files"
    for gitignore in $(cd ${src} && find . -name .gitignore); do
      cp -- "${src}/$gitignore" "$gitignore"
    done

    # check-ignore exits with 1 when it ignores nothing and above 1 on errors.
    status=0
    git check-ignore --no-index --stdin < "$all" > "$TMPDIR/ignored" || status=$?
    if [ "$status" -gt 1 ]; then exit "$status"; fi
    sort "$TMPDIR/ignored" > "$TMPDIR/ignored-by-git"
    sort "$dropped" > "$TMPDIR/dropped-by-nix"
    if ! diff -u --label "dropped by the package source" --label "ignored by git" \
      "$TMPDIR/dropped-by-nix" "$TMPDIR/ignored-by-git"; then
      echo "The package source and .gitignore disagree on the paths above." >&2
      exit 1
    fi
    touch "$out"
  ''
