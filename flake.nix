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
              cd packages/sqlite-worker-core
              wasm-pack test --headless --chrome
              cd ../..
              cd packages/sqlite-worker
              wasm-pack test --headless --chrome
              cd ../..
            '';
          };

          build-wasm = rainix.mkTask.${system} {
            name = "build-wasm";
            body = ''
              set -euxo pipefail
              cd packages/sqlite-worker-core
              wasm-pack build --target web --out-dir ../../pkg
              cd ../..
              cd packages/sqlite-worker
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
          packages = [ packages.test-wasm packages.build-wasm packages.local-bundle packages.test-ui packages.test-full-integration ];
          inputsFrom = [ rainix.devShells.${system}.default ];
        };
      });
}
