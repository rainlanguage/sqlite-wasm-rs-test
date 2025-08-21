{
  description = "Flake for development workflows.";

  inputs = {
    rainix.url = "github:rainprotocol/rainix";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, flake-utils, rainix }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = rainix.pkgs.${system};
      in rec {
        packages = rainix.packages.${system} // {
          test-wasm = rainix.mkTask.${system} {
            name = "test-wasm";
            body = ''
              set -euxo pipefail
              cd packages/sqlite-web-core
              wasm-pack test --headless --chrome
              cd ../..
              cd packages/sqlite-web
              wasm-pack test --headless --chrome
              cd ../..
            '';
          };

          build-wasm = rainix.mkTask.${system} {
            name = "build-wasm";
            body = ''
              set -euxo pipefail
              cd packages/sqlite-web-core
              wasm-pack build --target web --out-dir ../../pkg
              cd ../..
              cd packages/sqlite-web
              wasm-pack build --target web --out-dir ../../pkg
              cd ../..
            '';
          };

          local-bundle = rainix.mkTask.${system} {
            name = "local-bundle";
            body = ''
              set -euxo pipefail
              ./scripts/local-bundle.sh
            '';
          };

          test-ui = rainix.mkTask.${system} {
            name = "test-ui";
            body = ''
              set -euxo pipefail
              ./scripts/local-bundle.sh
              cd svelte-test
              npm run test
              cd ..
            '';
          };

          build-submodules = rainix.mkTask.${system} {
            name = "build-submodules";
            body = ''
              set -euxo pipefail
              rainix-sol-prelude
              cd lib/rain.math.float
              forge build
              cd ../..
            '';
          };

          test-full-integration = rainix.mkTask.${system} {
            name = "test-full-integration";
            body = ''
              set -euxo pipefail
              ${packages.test-wasm}/bin/test-wasm
              ${packages.test-ui}/bin/test-ui
            '';
          };
        };

        devShells.default = pkgs.mkShell {
          shellHook = rainix.devShells.${system}.default.shellHook;
          packages = [ packages.test-wasm packages.build-wasm packages.local-bundle packages.test-ui packages.build-submodules packages.test-full-integration pkgs.wasm-pack ];
          inputsFrom = [ rainix.devShells.${system}.default ];
        };
      });
}
