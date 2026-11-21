import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildWindowsCommand, mapWindowsDisksToModel } = require('../electron/diskBackend.cjs');

test('buildWindowsCommand rejects PowerShell injection payloads', () => {
  assert.throws(
    () => buildWindowsCommand({ type: 'delete', diskNumber: '0; calc.exe', partitionNumber: 1, params: {} }),
    /Paramètre invalide/
  );
  assert.throws(
    () => buildWindowsCommand({ type: 'format', diskNumber: 1, params: { letter: 'D; whoami', fileSystem: 'NTFS', label: 'Test' } }),
    /Lettre de lecteur invalide/
  );
  assert.throws(
    () => buildWindowsCommand({ type: 'create', diskNumber: 1, params: { sizeGB: 10, fileSystem: 'NTFS; calc', letter: 'K:', label: 'X' } }),
    /Système de fichiers/
  );
  assert.throws(
    () => buildWindowsCommand({ type: 'clone_disk', diskNumber: 1, params: {} }),
    /Mode Simulation/
  );
  assert.throws(
    () => buildWindowsCommand({ type: 'check_partition', diskNumber: 1, params: { letter: '' } }),
    /Lettre de lecteur requise/
  );
});

test('buildWindowsCommand generates safe escaped commands for valid operations', () => {
  const cmdCreate = buildWindowsCommand({
    type: 'create',
    diskNumber: 1,
    params: { sizeGB: 20, fileSystem: 'NTFS', letter: 'K:', label: "O'Brien" },
  });
  assert.match(cmdCreate, /^New-Partition -DiskNumber 1 -Size \d+ -DriveLetter K \| Format-Volume -FileSystem NTFS -NewFileSystemLabel 'O''Brien' -Confirm:\$false$/);

  const cmdCheck = buildWindowsCommand({
    type: 'check_partition',
    diskNumber: 0,
    params: { letter: 'D:' },
  });
  assert.equal(cmdCheck, 'Repair-Volume -DriveLetter D -Scan');

  const cmdRemoveLetter = buildWindowsCommand({
    type: 'letter',
    diskNumber: 1,
    partitionNumber: 2,
    params: { newLetter: '', oldLetter: 'E:' },
  });
  assert.equal(cmdRemoveLetter, "Remove-PartitionAccessPath -DiskNumber 1 -PartitionNumber 2 -AccessPath 'E:\\'");
});

test('buildWindowsCommand rejects EXT4 and FAT32 > 32GB in native Windows mode', () => {
  assert.throws(
    () => buildWindowsCommand({ type: 'create', diskNumber: 1, params: { sizeGB: 50, fileSystem: 'EXT4', letter: '', label: 'Linux' } }),
    /non pris en charge/
  );
  assert.throws(
    () => buildWindowsCommand({ type: 'create', diskNumber: 1, params: { sizeGB: 64, fileSystem: 'FAT32', letter: 'K:', label: 'BigFat' } }),
    /32 Go/
  );
});

test('mapWindowsDisksToModel maps Windows PowerShell schema and computes Unallocated tail gap', () => {
  const GB = 1024 ** 3;
  const mapped = mapWindowsDisksToModel([
    {
      number: 0,
      model: 'Test NVMe',
      serial: 'SN123',
      busType: 'NVMe',
      mediaType: 'SSD',
      partitionStyle: 'GPT',
      sizeBytes: 500 * GB,
      status: 'Online',
      health: 'Healthy',
      temperature: null,
      wear: null,
      powerOnHours: null,
      readErrors: 0,
      partitions: [
        {
          partitionNumber: 1,
          letter: 'C:',
          label: 'OS',
          fileSystem: 'NTFS',
          sizeBytes: 300 * GB,
          usedGB: 120,
          offsetBytes: 1024 * 1024,
          isSystem: true,
          type: 'Basic',
          aligned4K: true,
        },
      ],
    },
  ]);

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, 'win-disk-0');
  assert.equal(mapped[0].health, 'Sain');
  assert.equal(mapped[0].status, 'En ligne');
  assert.equal(mapped[0].smart.temperatureC, null);
  assert.equal(mapped[0].partitions.length, 2);
  assert.equal(mapped[0].partitions[0].partitionNumber, 1);
  assert.equal(mapped[0].partitions[1].fileSystem, 'Unallocated');
  assert.equal(mapped[0].partitions[1].partitionNumber, 0);
  assert.ok(mapped[0].partitions[1].sizeGB > 199 && mapped[0].partitions[1].sizeGB < 201);
});
