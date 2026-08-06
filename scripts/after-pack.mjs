import { lstatSync, readdirSync, realpathSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'

/**
 * Packing strategy:
 *
 * 1) electron-builder copies `backend/` (extraResources) but we EXCLUDE
 *    `.venv` and `__pycache__` (package.json filter). electron-builder's
 *    FileCopier does `copyFile` + `chmod(dest, srcMode)`, and `uv` venvs
 *    contain files hard-linked into the uv cache with a
 *    `com.apple.provenance` xattr — macOS refuses to chmod those, so the
 *    copy dies with EPERM.
 *
 * 2) This hook copies the `.venv` from the SOURCE backend over with
 *    `rsync -a` (fresh inodes, no xattrs, no hardlinks), dereferences the
 *    `uv` interpreter symlinks, and drops `libpython*.dylib` so the bundled
 *    Python can run.
 */

function projectVenvCopy(srcBackend, destBackend) {
  const src = join(srcBackend, '.venv')
  const dst = join(destBackend, '.venv')
  execSync(`mkdir -p "${dst}"`, { stdio: 'ignore' })
  execSync(`rsync -a "${src}/" "${dst}/"`, { stdio: 'ignore' })
}

function dereferenceTree(root) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        const target = realpathSync(abs)
        execSync(`rm "${abs}" && cp -L "${target}" "${abs}"`, { stdio: 'ignore' })
      } else if (st.isDirectory()) {
        walk(abs)
      }
    }
  }
  walk(root)
}

function installLibPython(venvBin) {
  const pythonPath = join(venvBin, "python")
  const realPython = realpathSync(pythonPath)
  const realLibDir = join(dirname(dirname(realPython)), "lib")
  const dylib = readdirSync(realLibDir).find((n) => n.startsWith("libpython") && n.endsWith(".dylib"))
  if (!dylib) return
  const target = join(venvBin, "..", "lib", dylib)
  execSync(`mkdir -p "${dirname(target)}"`, { stdio: 'ignore' })
  execSync(`cp "${join(realLibDir, dylib)}" "${target}"`, { stdio: 'ignore' })
  execSync(`install_name_tool -id "@executable_path/../lib/${dylib}" "${target}"`, { stdio: 'ignore' })
}

export default async function afterPack(context) {
  const { appOutDir, packager } = context
  const productName = packager?.appInfo?.productFilename || 'Coder AI'
  const projectDir = packager?.projectDir || process.cwd()
  const srcBackend = join(projectDir, 'backend')
  const backendRoot =
    process.platform === 'darwin'
      ? join(appOutDir, `${productName}.app`, 'Contents', 'Resources', 'backend')
      : join(appOutDir, 'resources', 'backend')
  const venvBin = join(backendRoot, '.venv', 'bin')

  try {
    projectVenvCopy(srcBackend, backendRoot)
    // Resolve libpython while `.venv/bin/python` is still the uv symlink; after
    // dereferencing it becomes a real binary whose realpath is itself.
    if (process.platform === "darwin") installLibPython(venvBin)
    dereferenceTree(venvBin)
    console.log('after-pack: copied venv via rsync, fixed libpython, dereferenced symlinks')
  } catch (err) {
    console.error('after-pack: failed to normalize backend bundle', err.message)
  }
}