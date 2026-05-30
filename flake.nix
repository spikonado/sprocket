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

        devShells.default = pkgs.mkShell.override { stdenv = pkgs.clangStdenv; } {
          packages =
            with pkgs;
            [
              bun
              commitlint
              cargo
              cargo-edit
              gcc
              nodejs_24
              prek
              rustc
              rustfmt
              rust-analyzer
            ]
            ++ electronRuntimeLibs;

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath electronRuntimeLibs;
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
