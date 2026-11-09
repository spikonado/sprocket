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
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ bunOverlay ];
        };
        rustToolchain = (builtins.fromTOML (builtins.readFile ./rust-toolchain.toml)).toolchain;
        # Uses the Bun release the host installs for agents, so one pin covers both.
        bunOverlay = final: prev: {
          bun =
            let
              release = builtins.fromJSON (builtins.readFile ./tools/bun/releases.json);
              platform =
                {
                  aarch64-darwin = "darwin-arm64";
                  aarch64-linux = "linux-arm64";
                  x86_64-linux = "linux-x64";
                }
                .${system};
            in
            prev.bun.overrideAttrs {
              inherit (release) version;
              src = final.fetchurl { inherit (release.platforms.${platform}) url sha256; };
              sourceRoot = "package/bin";
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
            nodejs_26
          ];
        };

        devShells.kicad = pkgs.mkShell {
          packages = with pkgs; [
            bun
            dwarfs
            minisign
            osslsigncode
            rcodesign
            unzip
            uv
          ];
        };

        devShells.default = pkgs.mkShell.override { stdenv = pkgs.clangStdenv; } {
          packages =
            with pkgs;
            [
              bun
              commitlint
              cargo-edit
              gcc
              nodejs_26
              prek
              rustup
            ]
            ++ electronRuntimeLibs;

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath electronRuntimeLibs;

          shellHook = ''
            export PATH="''${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
            export PATH="''${RUSTUP_HOME:-$HOME/.rustup}/toolchains/${rustToolchain.channel}-${pkgs.stdenv.hostPlatform.rust.rustcTarget}/bin:$PATH"
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
