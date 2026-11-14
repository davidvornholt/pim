{
  description = "pim and its development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      manifest = builtins.fromJSON (builtins.readFile ./package.json);
      bunFor =
        system:
        nixpkgs.legacyPackages.${system}.callPackage ./nix/standards-bun.nix {
          inherit (manifest) packageManager;
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pim = nixpkgs.legacyPackages.${system}.callPackage ./nix/package.nix {
            bun = bunFor system;
            inherit (self) lastModifiedDate;
          };
        in
        {
          default = pim;
          inherit pim;
        }
      );

      checks = forAllSystems (system: {
        package-source = nixpkgs.legacyPackages.${system}.callPackage ./nix/package-source-check.nix {
          inherit (self.packages.${system}.pim) src;
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bun = bunFor system;
          localShell =
            if builtins.pathExists ./dev-shell.local.nix then
              import ./dev-shell.local.nix { inherit pkgs; }
            else
              { };
        in
        {
          default = pkgs.mkShell (
            localShell
            // {
              packages = [ bun ] ++ (localShell.packages or [ ]);
            }
          );
        }
      );
    };
}
