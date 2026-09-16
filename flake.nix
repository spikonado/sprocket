{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        kacheVersion = "0.19.0";
        kacheArtifact =
          {
            x86_64-linux = {
              target = "x86_64-unknown-linux-musl";
              hash = "sha256-ZNjhCrwekWhZzlvyk3iH3xWTPhtl5moe/n3Habyqd5g=";
            };
            aarch64-linux = {
              target = "aarch64-unknown-linux-musl";
              hash = "sha256-z5iAIA0oyosswztSJ7nMJglMR8CSf3eRc0wCuhpc1qw=";
            };
            x86_64-darwin = {
              target = "x86_64-apple-darwin";
              hash = "sha256-FiZG+UQDwqLjDcM1e5upesvHiKKXY0zXVZvrM9g8DUw=";
            };
            aarch64-darwin = {
              target = "aarch64-apple-darwin";
              hash = "sha256-jc2qlfNniwBpbKR0LYrWfB8A2bqn0ULL+TN7Pz7LA7c=";
            };
          }
          .${system};
        kache = pkgs.stdenvNoCC.mkDerivation {
          pname = "kache";
          version = kacheVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/kunobi-ninja/kache/releases/download/v${kacheVersion}/kache-${kacheArtifact.target}.tar.gz";
            inherit (kacheArtifact) hash;
          };
          sourceRoot = ".";
          installPhase = ''
            install -Dm755 kache "$out/bin/kache"
          '';
          meta = {
            description = "Content-addressed compiler cache";
            homepage = "https://kunobi.ninja/product/kache";
            license = pkgs.lib.licenses.asl20;
            mainProgram = "kache";
            sourceProvenance = [ pkgs.lib.sourceTypes.binaryNativeCode ];
          };
        };
        electronRuntimeLibs = with pkgs; [
          alsa-lib
          atk
          cairo
          cups
          dbus
          expat
          glib
          gtk3
          libdrm
          libgbm
          libGL
          libxcb
          libxkbcommon
          libX11
          libXcomposite
          libXdamage
          libXext
          libXfixes
          libXrandr
          mesa
          nspr
          nss
          pango
        ];
      in
      {
        formatter = pkgs.nixfmt-tree;

        devShells.convex = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_24
          ];
        };

        devShells.default = pkgs.mkShell.override { stdenv = pkgs.clangStdenv; } {
          packages =
            with pkgs;
            [
              bun
              commitlint
              cargo
              cargo-edit
              gcc
              kache
              nodejs_24
              prek
              rustc
              rustfmt
              rust-analyzer
            ]
            ++ electronRuntimeLibs;

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath electronRuntimeLibs;
          shellHook = ''
            if [[ -z "''${CI:-}" ]]; then
              export RUSTC_WRAPPER="${pkgs.lib.getExe kache}"
            fi
          '';
        };
      }
    );
  nixConfig = {
    extra-substituters = [
      "https://spikonado.cachix.org"
    ];
    extra-trusted-public-keys = [
      "spikonado.cachix.org-1:MwA4hqRN0+DdP7/UnTn0yvJgVu65S1S0QVnAnsguev4="
    ];
  };
}
