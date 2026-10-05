# Releasing

## Validate the version

1. Update `package.json`, `package-lock.json`, `executor-plugin/plugin.yaml`, `executor-plugin/dashboard/manifest.json`, `native-extension/manifest.json`, the `background.mjs` handshake, README versions and version tests consistently. Preserve the extension manifest `key` and verify the fixed extension ID. Move the corresponding changelog entries into the release section and create `docs/release-<version>.md`, which the tag workflow uses as its release notes.
2. Run the core checks and the pinned Hermes integration gate in [testing.md](testing.md). Record their environments and outcomes separately from real-browser checks.
3. Build a candidate and exercise the changed flows through temporary Chrome/Edge profiles and an isolated installation. Use synthetic data. Preserve explicit limitations; do not call unavailable checks passed.
4. Review public documentation, package contents and source provenance. The root MIT license retains both the original extension copyright and the bridge maintainer's notice. Development dependencies are not bundled in the installation archive.

## Separate public source from private development history

A clean working directory and `.gitignore` do not remove old Git objects. Do not switch an existing private development repository to public as a shortcut. Keep its history private and publish an independently reviewed source snapshot in a separate repository.

```sh
# 中文注释：此命令只导出一个已提交版本，不复制 .git、忽略文件或历史记录。
python3 scripts/prepare-public-source.py --ref HEAD --output artifacts/public-source-1.8.1
```

The exporter refuses tracked runtime data, symlinks, archives and unreviewed binary blobs. The two synthetic benchmark PNG assets and the exact reviewed branding-image hashes are explicitly allowed; other binary content is refused. It prints a content hash and does not publish anything. Scan the exported directory with the pinned Gitleaks version from `secrets.yml`; inspect findings instead of applying broad allowlists. The configuration permits only named, fixed synthetic test values. Real-looking negative controls must still be detected.

Initialize a new repository in the reviewed export, use an appropriate public author identity, commit it, and verify that its history contains only the intended public commits. A private staging branch can run CI before public publication. Never force-push or delete the development history without a separately reviewed migration plan.

## Build immutable release artifacts

Run the packager from the committed public source repository:

```sh
node scripts/package-executor.mjs --release 1.8.1 --output out/browser-link-1.8.1
```

The packager requires a clean working tree, consistent versions and Git-tracked release inputs. It records the public source commit in `RELEASE-STATUS.txt` and lists package file hashes in `SHA256SUMS.json`. Even an ignored, untracked runtime input is refused. Packaging does not install or enable anything.

The tag-triggered `.github/workflows/release.yml` builds `hermes-browser-link-<version>.zip`, including `install.sh` and `SHA256SUMS.json`, and attaches the ZIP and per-file manifest to a stable GitHub Release. Repeat isolated install/upgrade/uninstall acceptance after changing packaged runtime files. Preserve the exact source commit and checksums in the release record.

## Publish

Before the final public action, verify:

- The destination repository and its branches/tags contain only the reviewed public history. Changing visibility can expose more than the default branch.
- CI is green for the source being published. Provider keys, personal browser profiles and private installation files are never CI inputs.
- Private vulnerability reporting is enabled and the reporting link works for outside contributors.
- The release notes clearly label this version as a macOS stable release and identify unverified platforms or features.

Only after explicit publication approval, create tag `v1.8.1` at the verified public source commit. The release workflow then publishes the installation ZIP and checksums as a stable GitHub Release; GitHub also supplies the source archive. Writing the workflow alone does not create a tag or publish a release. The `private: true` flag in `package.json` prevents accidental npm publication; it does not prevent MIT licensing or a public GitHub repository.

A draft release or a local artifact is not public publication. Record the final release URL only after it exists.
