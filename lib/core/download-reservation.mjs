import { open, unlink } from 'node:fs/promises';

function recordCleanupError(primary, cleanup) {
  if (!primary.cleanupErrors) primary.cleanupErrors = [];
  primary.cleanupErrors.push(cleanup);
}

async function closeWithoutMasking(handle, primary) {
  try {
    await handle.close();
  } catch (error) {
    if (primary) recordCleanupError(primary, error);
  }
}

async function unlinkWithoutFollowing(downloadPath, unlinkFile, primary) {
  try {
    await unlinkFile(downloadPath);
  } catch (error) {
    if (error.code !== 'ENOENT' && primary) recordCleanupError(primary, error);
  }
}

export async function reserveDownload(
  downloadPath,
  { openFile = open, unlinkFile = unlink } = {},
) {
  let handle;
  try {
    handle = await openFile(downloadPath, 'wx', 0o600);
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    if (handle) {
      await closeWithoutMasking(handle, error);
      await unlinkWithoutFollowing(downloadPath, unlinkFile, error);
    }
    throw error;
  }
}

export async function cleanupDownloadReservation(
  downloadPath,
  handle,
  { unlinkFile = unlink } = {},
) {
  if (handle) await closeWithoutMasking(handle);
  await unlinkWithoutFollowing(downloadPath, unlinkFile);
}
