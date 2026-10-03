import {
  randomUUID,
} from 'node:crypto';

import {
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';

import {
  dirname,
} from 'node:path';

export async function durableReplace(
  filePath: string,
  contents: string,
): Promise<void> {
  const tempPath =
    `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  let file: FileHandle | undefined;
  let directory: FileHandle | undefined;
  let ownsTemp = false;

  try {
    directory = await open(dirname(filePath), 'r');

    file = await open(tempPath, 'wx', 0o600);
    ownsTemp = true;

    await file.writeFile(contents, 'utf8');
    await file.sync();

    const completedFile = file;
    file = undefined;
    await completedFile.close();

    await rename(tempPath, filePath);
    ownsTemp = false;

    await directory.sync();

    const completedDirectory = directory;
    directory = undefined;
    
    try {
      await completedDirectory.close();
    } catch {
      // Directory sync succeeded. Cleanup must not change that result.
    }
  } catch (cause) {
    // Never retry sync on failed handle. A future attempt must write
    // the complete snapshot through a new temporary file.
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        // Preserve the original persistence failure.
      }
    }

    if (directory !== undefined) {
      try {
        await directory.close();
      } catch {
        // Preserve the original persistence failure.
      }
    }

    if (ownsTemp) {
      try {
        await unlink(tempPath);
      } catch {
        // Startup cleanup can remove an orphaned temporary file.
      }
    }

    // Rename may have already succeeded. Do not remove or restore
    // the destination, and do not claim the previous state survived.
    throw new Error(
      'Checkpoint persistence did not complete. ' +
      'The on-disk outcome may be uncertain.',
      { cause },
    );
  }
}