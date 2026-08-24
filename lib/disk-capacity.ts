import { statfs } from 'node:fs/promises';

export const MINIMUM_FREE_DISK_FRACTION = 0.10;

export interface DiskCapacityStatus {
  totalBytes: number;
  availableBytes: number;
  minimumAvailableBytes: number;
  deficitBytes: number;
  availableFraction: number;
  minimumFreeFraction: number;
  ok: boolean;
}

export function assessDiskCapacity(
  totalBytes: number,
  availableBytes: number,
  minimumFreeFraction = MINIMUM_FREE_DISK_FRACTION,
): DiskCapacityStatus {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error('Disk total bytes must be a positive safe integer.');
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 || availableBytes > totalBytes) {
    throw new Error('Disk available bytes must be a safe integer within the filesystem total.');
  }
  if (!Number.isFinite(minimumFreeFraction) || minimumFreeFraction <= 0 || minimumFreeFraction >= 1) {
    throw new Error('Minimum free disk fraction must be between zero and one.');
  }
  const minimumAvailableBytes = Math.ceil(totalBytes * minimumFreeFraction);
  return {
    totalBytes,
    availableBytes,
    minimumAvailableBytes,
    deficitBytes: Math.max(0, minimumAvailableBytes - availableBytes),
    availableFraction: availableBytes / totalBytes,
    minimumFreeFraction,
    ok: availableBytes >= minimumAvailableBytes,
  };
}

/** Uses blocks available to the unprivileged worker, matching the space it can actually allocate. */
export async function readDiskCapacity(target = process.cwd()): Promise<DiskCapacityStatus> {
  const details = await statfs(target);
  const totalBytes = details.blocks * details.bsize;
  const availableBytes = details.bavail * details.bsize;
  return assessDiskCapacity(totalBytes, availableBytes);
}
