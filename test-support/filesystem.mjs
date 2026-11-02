import fs from 'node:fs/promises'

// Windows junctions exercise linked-directory safety without symlink privileges.
export function directoryLink(target, link) {
  return fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

// Call only inside a file-symlink subtest so unrelated security checks still run.
export async function fileSymlink(t, target, link) {
  try {
    await fs.symlink(target, link, 'file')
    return true
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    t.skip(`Windows file symlinks are unavailable (${error.code}); enable Developer Mode or symlink privileges to run this subtest.`)
    return false
  }
}
