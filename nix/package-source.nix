# The repository's files that git doesn't ignore, as a package source.
#
# A git flake copies only tracked files, but a path: flake or a build from a
# working tree copies everything the filter keeps into the world-readable Nix
# store. Following .gitignore keeps local files such as .env.local and
# config/dev.local.yaml out without a list of names to maintain here.
#
# Each directory's .gitignore applies to the paths below it, a later or deeper
# pattern overrides an earlier one, a pattern ending in a slash matches only
# directories, and nothing below an ignored directory is kept, as in git.
# nix-gitignore translates each pattern into a regular expression.
# package-source-check.nix compares the result with git itself.
{ lib, nix-gitignore }:
root:
let
  rootString = toString root;
  pathOf = dir: if dir == "" then rootString else "${rootString}/${dir}";
  parentOf =
    dir:
    let
      parent = dirOf dir;
    in
    if parent == "." then "" else parent;

  # The patterns of the .gitignore in dir, which is relative to the root.
  rulesIn =
    dir:
    let
      file = "${pathOf dir}/.gitignore";
      lines = lib.splitString "\n" (if builtins.pathExists file then builtins.readFile file else "");
      isPattern = line: builtins.match "(#.*|[[:space:]]*)" line == null;
    in
    map (
      line:
      let
        pattern = builtins.head (nix-gitignore.gitignoreToPatterns line);
      in
      {
        base = dir;
        regex = builtins.head pattern;
        # True for a pattern that starts with `!` and so keeps what it matches.
        keep = lib.last pattern;
        directoryOnly = lib.hasSuffix "/" line;
      }
    ) (lib.filter isPattern lines);

  # Whether git keeps relative path, given the patterns that apply to it.
  keeps =
    rules: relative: type:
    let
      relativeTo = base: if base == "" then relative else lib.removePrefix "${base}/" relative;
      matches =
        rule:
        (!rule.directoryOnly || type == "directory")
        && builtins.match rule.regex (relativeTo rule.base) != null;
      matching = lib.filter matches rules;
    in
    matching == [ ] || (lib.last matching).keep;

  # The patterns that apply inside each directory the source keeps, by the
  # directory's path relative to the root.
  rulesByDirectory =
    let
      walk =
        dir: inherited:
        let
          rules = inherited ++ rulesIn dir;
          subdirectories = lib.filter (
            name:
            let
              relative = if dir == "" then name else "${dir}/${name}";
            in
            lib.cleanSourceFilter "${rootString}/${relative}" "directory" && keeps rules relative "directory"
          ) (lib.attrNames (lib.filterAttrs (_: type: type == "directory") (builtins.readDir (pathOf dir))));
        in
        lib.foldl' (acc: name: acc // walk (if dir == "" then name else "${dir}/${name}") rules) {
          ${dir} = rules;
        } subdirectories;
    in
    walk "" [ ];
  # A directory that doesn't exist has no .gitignore of its own.
  rulesFor = dir: rulesByDirectory.${dir} or (rulesFor (parentOf dir));
in
lib.cleanSourceWith {
  src = lib.cleanSource root;
  filter =
    path: type:
    let
      relative = lib.removePrefix "${rootString}/" path;
    in
    keeps (rulesFor (parentOf relative)) relative type;
}
