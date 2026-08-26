import { readDiskCapacity } from '../src/lib/disk-capacity';

const gib = (bytes: number) => Number((bytes / 1024 ** 3).toFixed(2));

readDiskCapacity()
  .then((status) => {
    console.log(JSON.stringify({
      ok: status.ok,
      totalGiB: gib(status.totalBytes),
      availableGiB: gib(status.availableBytes),
      minimumAvailableGiB: gib(status.minimumAvailableBytes),
      deficitGiB: gib(status.deficitBytes),
      availablePercent: Number((status.availableFraction * 100).toFixed(2)),
      minimumFreePercent: status.minimumFreeFraction * 100,
    }, null, 2));
    if (!status.ok) process.exitCode = 1;
  })
  .catch((error) => {
    console.error('Disk capacity check failed:', error);
    process.exitCode = 1;
  });
