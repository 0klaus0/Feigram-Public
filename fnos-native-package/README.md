Feigram FPK template.

The source repository does not track the Linux x64 Node.js runtime or the packaged server dependency tree. Run `scripts/build-native-fpk.sh` from the repository root; it prepares the runtime, builds the web UI, copies the latest server files into the package workspace, installs production dependencies, and writes the final `.fpk` file under `release/`.
