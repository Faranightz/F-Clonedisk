import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  sanitizeVolumeLabel,
  verifyDiskIdentity,
  verifyPartitionByLetter,
  buildWindowsCommand,
  prepareOperations,
  formatConfirmationSummary,
  mapWindowsDisksToModel,
} = require('../electron/diskBackend.cjs');

const SAMPLE_DISK_IDENTITY = {
  diskNumber: 1,
  model: 'Crucial MX500 SATA SSD 500GB',
  serial: 'CT500MX500SSD1-2204E',
  uniqueId: '500A07512204E111',
  sizeBytes: 500 * 1024 ** 3,
  sizeGB: 500,
};

// ---------------------------------------------------------------------------
// Étape 1.1 — Numéros de partition : ne jamais renuméroter par position et
// bloquer les opérations chaînées sur une partition fraîchement créée en file
// ---------------------------------------------------------------------------
test('1.1 normalizePartitions preserves real Windows PartitionNumber and blocks ops on pending-new partitions', async () => {
  // Compile/read diskEngine logic via direct TypeScript check + runtime verification on behavior
  const diskEngineSrc = fs.readFileSync(path.join(process.cwd(), 'src/utils/diskEngine.ts'), 'utf8');
  assert.doesNotMatch(diskEngineSrc, /realIdx\s*\+=\s*1/, 'normalizePartitions must NOT renumber partitions by index');
  assert.match(diskEngineSrc, /isPendingNew:\s*true/, 'Newly created partitions must be marked isPendingNew');
  assert.match(diskEngineSrc, /assertPartitionHasRealNumber\(part\)/, 'Subsequent ops must assert real partition number');

  // Verify Windows mapper keeps real non-contiguous PartitionNumbers (e.g. 2 and 5) and 0 for Unallocated
  const GB = 1024 ** 3;
  const mapped = mapWindowsDisksToModel([
    {
      number: 1,
      model: 'Crucial MX500',
      serial: 'SN-TEST-1',
      uniqueId: 'UID-1',
      busType: 'SATA',
      mediaType: 'SSD',
      partitionStyle: 'GPT',
      sizeBytes: 500 * GB,
      status: 'Online',
      health: 'Healthy',
      partitions: [
        { partitionNumber: 2, letter: 'E:', label: 'Data', fileSystem: 'NTFS', sizeBytes: 100 * GB, usedGB: 20, offsetBytes: 1024 * 1024, type: 'Basic', aligned4K: true },
        { partitionNumber: 5, letter: 'F:', label: 'Backups', fileSystem: 'NTFS', sizeBytes: 150 * GB, usedGB: 50, offsetBytes: 200 * GB, type: 'Basic', aligned4K: true },
      ],
    },
  ]);

  const parts = mapped[0].partitions;
  assert.equal(parts[0].partitionNumber, 2, 'First real partition keeps Windows PartitionNumber 2');
  assert.equal(parts[1].fileSystem, 'Unallocated');
  assert.equal(parts[1].partitionNumber, 0, 'Middle Unallocated gap has PartitionNumber 0');
  assert.equal(parts[2].partitionNumber, 5, 'Second real partition keeps Windows PartitionNumber 5');
  assert.equal(parts[3].fileSystem, 'Unallocated');
  assert.equal(parts[3].partitionNumber, 0, 'Tail Unallocated gap has PartitionNumber 0');
});

// ---------------------------------------------------------------------------
// Étape 1.2 — Identité du disque (SerialNumber / UniqueId / Size)
// ---------------------------------------------------------------------------
test('1.2 verifyDiskIdentity accepts matching disk and blocks on SerialNumber, UniqueId, or Size mismatch', () => {
  // Exact match passes
  assert.doesNotThrow(() =>
    verifyDiskIdentity(SAMPLE_DISK_IDENTITY, {
      number: 1,
      serial: 'CT500MX500SSD1-2204E',
      uniqueId: '500A07512204E111',
      sizeBytes: 500 * 1024 ** 3,
    })
  );

  // UniqueId mismatch blocks
  assert.throws(
    () =>
      verifyDiskIdentity(SAMPLE_DISK_IDENTITY, {
        number: 1,
        serial: 'CT500MX500SSD1-2204E',
        uniqueId: 'DIFFERENT-UID-999',
        sizeBytes: 500 * 1024 ** 3,
      }),
    /UniqueId/
  );

  // SerialNumber mismatch blocks
  assert.throws(
    () =>
      verifyDiskIdentity(SAMPLE_DISK_IDENTITY, {
        number: 1,
        serial: 'WRONG-SERIAL-000',
        uniqueId: '500A07512204E111',
        sizeBytes: 500 * 1024 ** 3,
      }),
    /Numéro de série/
  );

  // Size mismatch blocks
  assert.throws(
    () =>
      verifyDiskIdentity(SAMPLE_DISK_IDENTITY, {
        number: 1,
        serial: 'CT500MX500SSD1-2204E',
        uniqueId: '500A07512204E111',
        sizeBytes: 1000 * 1024 ** 3,
      }),
    /Taille du Disque/
  );
});

// ---------------------------------------------------------------------------
// Étape 1.3 — Valider toute la file avant d'exécuter
// ---------------------------------------------------------------------------
test('1.3 prepareOperations validates the entire queue upfront and rejects all if any single op is invalid', () => {
  const validOp = {
    id: 'op-1',
    type: 'check_partition',
    diskNumber: 1,
    diskIdentity: SAMPLE_DISK_IDENTITY,
    params: { letter: 'E:' },
  };
  const invalidOp = {
    id: 'op-2',
    type: 'merge', // simulation-only operation
    diskNumber: 1,
    diskIdentity: SAMPLE_DISK_IDENTITY,
    params: {},
  };

  assert.throws(() => prepareOperations([validOp, invalidOp]), /Mode Simulation/);

  // Also rejects missing diskIdentity
  assert.throws(
    () => prepareOperations([{ id: 'op-3', type: 'check_partition', diskNumber: 1, params: { letter: 'E:' } }]),
    /Identité du disque manquante/
  );
});

// ---------------------------------------------------------------------------
// Étape 1.4 — Confirmation : vraies commandes, modèle et n° de série (pas op.title)
// ---------------------------------------------------------------------------
test('1.4 formatConfirmationSummary displays real PowerShell commands, model, and serial — never op.title', () => {
  const prepared = prepareOperations([
    {
      id: 'op-1',
      type: 'label',
      diskNumber: 1,
      diskIdentity: SAMPLE_DISK_IDENTITY,
      title: 'TITRE_TROMPEUR_NE_PAS_AFFICHER',
      params: { letter: 'E:', newLabel: 'Sauvegarde-2026' },
    },
  ]);

  const summary = formatConfirmationSummary(prepared);
  assert.match(summary, /Crucial MX500 SATA SSD 500GB/);
  assert.match(summary, /CT500MX500SSD1-2204E/);
  assert.match(summary, /Set-Volume -DriveLetter E -NewFileSystemLabel 'Sauvegarde-2026'/);
  assert.doesNotMatch(summary, /TITRE_TROMPEUR_NE_PAS_AFFICHER/);
});

// ---------------------------------------------------------------------------
// Étape 1.5 — Formatage et retrait de lettre : vérification par lettre + IsSystem/IsBoot + DiskNumber
// ---------------------------------------------------------------------------
test('1.5 verifyPartitionByLetter blocks IsSystem/IsBoot and diskNumber mismatch for format and letter removal', () => {
  const formatOp = { type: 'format', diskNumber: 1, params: { letter: 'E:', fileSystem: 'NTFS', label: 'Data' } };
  const removeLetterOp = { type: 'letter', diskNumber: 1, partitionNumber: 2, params: { newLetter: '', oldLetter: 'E:' } };

  // Valid non-system partition on expected disk passes
  assert.doesNotThrow(() =>
    verifyPartitionByLetter(formatOp, { diskNumber: 1, partitionNumber: 2, isSystem: false, isBoot: false })
  );
  assert.doesNotThrow(() =>
    verifyPartitionByLetter(removeLetterOp, { diskNumber: 1, partitionNumber: 2, isSystem: false, isBoot: false })
  );

  // IsSystem or IsBoot blocks both format and letter removal
  assert.throws(
    () => verifyPartitionByLetter(formatOp, { diskNumber: 1, partitionNumber: 2, isSystem: true, isBoot: false }),
    /Protection système/
  );
  assert.throws(
    () => verifyPartitionByLetter(removeLetterOp, { diskNumber: 1, partitionNumber: 2, isSystem: false, isBoot: true }),
    /Protection système/
  );

  // Wrong DiskNumber blocks both
  assert.throws(
    () => verifyPartitionByLetter(formatOp, { diskNumber: 0, partitionNumber: 2, isSystem: false, isBoot: false }),
    /Incohérence de disque/
  );
  assert.throws(
    () => verifyPartitionByLetter(removeLetterOp, { diskNumber: 2, partitionNumber: 2, isSystem: false, isBoot: false }),
    /Incohérence de disque/
  );
});

// ---------------------------------------------------------------------------
// Étape 1.6 — Noms de volume : rejeter guillemets droits/typographiques et caractères spéciaux
// ---------------------------------------------------------------------------
test('1.6 sanitizeVolumeLabel allows letters/digits/space/hyphen and rejects straight & typographic quotes', () => {
  assert.equal(sanitizeVolumeLabel('Projets-2026_OK'), 'Projets-2026_OK');
  assert.equal(sanitizeVolumeLabel('Mon Disque 1'), 'Mon Disque 1');
  assert.equal(sanitizeVolumeLabel(''), '');

  const forbidden = [
    "O'Brien",
    'Test‘quote',
    'Test’quote',
    'Test‚quote',
    'Test‛quote',
    'Test›quote',
    'Test"quote',
    'Disk$(calc)',
    'Disk;whoami',
    'Disk`nInject',
  ];
  for (const bad of forbidden) {
    assert.throws(() => sanitizeVolumeLabel(bad), /Nom de volume invalide/, `Expected rejection for: ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Étape 1.7 — MBR -> GPT : mbr2gpt /validate avant /convert + rappel BIOS UEFI
// ---------------------------------------------------------------------------
test('1.7 convert_gpt runs mbr2gpt /validate before /convert and confirmation includes UEFI BIOS notice', () => {
  const op = {
    id: 'op-gpt',
    type: 'convert_gpt',
    diskNumber: 2,
    diskIdentity: { ...SAMPLE_DISK_IDENTITY, diskNumber: 2 },
    params: { targetStyle: 'GPT' },
  };
  const cmd = buildWindowsCommand(op);
  const validateIdx = cmd.indexOf('mbr2gpt /validate /disk:2 /allowFullOS');
  const convertIdx = cmd.indexOf('mbr2gpt /convert /disk:2 /allowFullOS');
  assert.ok(validateIdx >= 0, 'Must run mbr2gpt /validate');
  assert.ok(convertIdx > validateIdx, 'Must run /convert strictly after /validate');
  assert.match(cmd, /\$LASTEXITCODE -ne 0/, 'Must abort if /validate fails');

  const summary = formatConfirmationSummary(prepareOperations([op]));
  assert.match(summary, /BIOS en mode UEFI/i);
});

// ---------------------------------------------------------------------------
// Étape 1.8 — .gitignore ignore *.tsbuildinfo + injection protections retained
// ---------------------------------------------------------------------------
test('1.8 .gitignore ignores *.tsbuildinfo and PowerShell injections remain blocked', () => {
  const gitignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');
  assert.match(gitignore, /\*\.tsbuildinfo/);

  assert.throws(
    () => buildWindowsCommand({ type: 'delete', diskNumber: '0; calc.exe', partitionNumber: 1, params: {} }),
    /Paramètre invalide/
  );
  assert.throws(
    () => buildWindowsCommand({ type: 'create', diskNumber: 1, params: { sizeGB: 64, fileSystem: 'FAT32', letter: 'K:', label: 'BigFat' } }),
    /32 Go/
  );
});

// ---------------------------------------------------------------------------
// Étape 2 — Modules réels (DiskWorker C#, smartctl, WinPE, wbadmin/VHDX, TestDisk, App Mover)
// ---------------------------------------------------------------------------
const advancedTools = require('../electron/advancedTools.cjs');

test('2.1 DiskWorker argument validation for wipe, clone, and surface test', () => {
  assert.deepEqual(advancedTools.buildWorkerArgs('wipe', { diskNumber: 1, method: 'dod3' }), ['wipe', '--disk', '1', '--method', 'dod3']);
  assert.deepEqual(advancedTools.buildWorkerArgs('clone', { sourceDiskNumber: 0, targetDiskNumber: 2 }), ['clone', '--src', '0', '--dst', '2']);
  assert.deepEqual(advancedTools.buildWorkerArgs('surface', { diskNumber: 1, segments: 192 }), ['surface', '--disk', '1', '--segments', '192', '--mode', 'quick']);

  assert.throws(() => advancedTools.buildWorkerArgs('wipe', { diskNumber: 1, method: 'gutmann35' }), /non supportée/);
  assert.throws(() => advancedTools.buildWorkerArgs('clone', { sourceDiskNumber: 1, targetDiskNumber: 1 }), /différents/);
});

test('2.2 parseSmartctlJson extracts NVMe & ATA SMART telemetry accurately', () => {
  const nvme = advancedTools.parseSmartctlJson({
    smart_status: { passed: true },
    temperature: { current: 41 },
    power_on_time: { hours: 2150 },
    power_cycle_count: 340,
    nvme_smart_health_information_log: {
      percentage_used: 3,
      data_units_written: 40000000,
      media_errors: 0,
      unsafe_shutdowns: 2,
    },
  });
  assert.equal(nvme.healthPercent, 97);
  assert.equal(nvme.temperatureC, 41);
  assert.equal(nvme.powerOnHours, 2150);
  assert.equal(nvme.totalWrittenTB, 20.48);
  assert.equal(nvme.wearLevelPercent, 3);
});

test('2.3 WinPE ADK, wbadmin/VHDX backup, TestDisk parser, and App Mover with rollback', () => {
  // WinPE blocks C:
  assert.throws(() => advancedTools.buildWinPeCommands({ mode: 'ufd', usbLetter: 'C:' }), /Protection système/);
  const winpe = advancedTools.buildWinPeCommands({ mode: 'iso', isoPath: 'D:\\WinPE\\FClonedisk.iso' });
  assert.match(winpe.commands[0], /copype amd64/);
  assert.match(winpe.commands[1], /MakeWinPEMedia \/ISO/);

  // Backup wbadmin & VHDX
  const wb = advancedTools.buildBackupCommand({ engine: 'wbadmin', sourceDrive: 'C:', targetDrive: 'F:' });
  assert.equal(wb, 'wbadmin start backup -backupTarget:F: -include:C: -allCritical -quiet');
  const vhdx = advancedTools.buildBackupCommand({ engine: 'vhdx', sourceDrive: 'C:', vhdxPath: 'F:\\Backups\\OS.vhdx', sizeGB: 120 });
  assert.match(vhdx, /New-VHD -Path 'F:\\Backups\\OS\.vhdx'/);
  assert.match(vhdx, /Dismount-VHD/);

  // TestDisk log parser
  const parsedTd = advancedTools.parseTestDiskLog(
    ' P NTFS                     0  32 33 15665  80 63  251658240 [Ancien_Studio]\n',
    2
  );
  assert.equal(parsedTd.length, 1);
  assert.equal(parsedTd[0].label, 'Ancien_Studio');
  assert.equal(parsedTd[0].fileSystem, 'NTFS');
  assert.equal(parsedTd[0].sizeGB, 120);

  // App Mover blocks C:\Windows and includes automatic rollback on mklink failure
  assert.throws(() => advancedTools.buildAppMoverScript('C:\\Windows\\System32', 'D:'), /Protection système/);
  const moveScript = advancedTools.buildAppMoverScript('C:\\Program Files\\Adobe', 'D:');
  assert.match(moveScript, /robocopy/);
  assert.match(moveScript, /mklink \/J/);
  assert.match(moveScript, /rollback automatique/);
});

// ---------------------------------------------------------------------------
// Étape 3 — Interface Charte Rapide iT & Polices auto-hébergées
// ---------------------------------------------------------------------------
test('3.1 Rapide iT brand palette (#1746D1, #E83E8C, #10213A, #F5F7FC) and self-hosted Manrope/Inter fonts', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf8');
  const mainTsx = fs.readFileSync(path.join(process.cwd(), 'src/main.tsx'), 'utf8');
  assert.match(css, /#1746d1/i);
  assert.match(css, /#e83e8c/i);
  assert.match(css, /#10213a/i);
  assert.match(css, /#f5f7fc/i);
  assert.match(mainTsx, /@fontsource\/manrope/);
  assert.match(mainTsx, /@fontsource\/inter/);
});

// ---------------------------------------------------------------------------
// Relecture Claude Code — clonage, migration, mise hors ligne, test de surface
// ---------------------------------------------------------------------------
const SOURCE_IDENTITY = {
  diskNumber: 0,
  model: 'Samsung 970 EVO Plus 1TB',
  serial: 'S4EWNX0R123456',
  uniqueId: '0025385B91234567',
  sizeBytes: 400 * 1024 ** 3,
  sizeGB: 400,
};

function cloneOp(overrides = {}) {
  return {
    id: 'op-clone',
    type: 'clone_disk',
    diskNumber: 1,
    diskIdentity: SAMPLE_DISK_IDENTITY,
    params: { sourceDiskNumber: 0, targetDiskNumber: 1, sourceIdentity: SOURCE_IDENTITY, ...overrides },
  };
}

test('R.1 clone and migration require and verify the SOURCE disk identity', () => {
  const prepared = prepareOperations([cloneOp()]);
  assert.equal(prepared[0].sourceIdentity.diskNumber, 0);
  assert.equal(prepared[0].sourceIdentity.serial, 'S4EWNX0R123456');

  assert.throws(() => prepareOperations([cloneOp({ sourceIdentity: undefined })]), /Identité du disque manquante/);
  assert.throws(
    () => prepareOperations([{ ...cloneOp(), type: 'migrate_os' , params: { sourceDiskNumber: 0, targetDiskNumber: 1 } }]),
    /Identité du disque manquante/
  );
  // Target announced in params must be the disk whose identity is verified
  assert.throws(() => prepareOperations([cloneOp({ targetDiskNumber: 2 })]), /Incohérence/);
  // Source and target pointing at the same physical disk
  assert.throws(
    () => prepareOperations([cloneOp({ sourceIdentity: { ...SAMPLE_DISK_IDENTITY, diskNumber: 0 } })]),
    /même disque physique/
  );
});

test('R.2 confirmation shows SOURCE and TARGET, raw operations take the disks offline first', () => {
  const prepared = prepareOperations([cloneOp()]);
  const summary = formatConfirmationSummary(prepared);
  assert.match(summary, /CIBLE \(écrasée\) : Disque 1/);
  assert.match(summary, /SOURCE \(lue\) : Disque 0 — Samsung 970 EVO Plus 1TB \| S\/N: S4EWNX0R123456/);
  assert.match(prepared[0].command, /^Set-Disk -Number 0 -IsOffline \$true ; Set-Disk -Number 1 -IsOffline \$true ; FClonedisk\.DiskWorker\.exe clone --src 0 --dst 1/);

  const wipe = buildWindowsCommand({ type: 'wipe_disk', diskNumber: 3, params: { method: 'dod3' } });
  assert.match(wipe, /^Set-Disk -Number 3 -IsOffline \$true ; FClonedisk\.DiskWorker\.exe wipe --disk 3 --method dod3 ; Set-Disk -Number 3 -IsOffline \$false$/);
});

test('R.3 OS migration finds EFI/Windows partitions itself and never uses fixed letters', () => {
  const plan = advancedTools.buildMigrateOsCommands(0, 1);
  assert.deepEqual(plan.workerArgs, ['clone', '--src', '0', '--dst', '1']);
  assert.match(plan.bcdCommand, /\$n = 1;/);
  assert.match(plan.bcdCommand, /c12a7328-f81f-11d2-ba4b-00a0c93ec93b/);
  assert.match(plan.bcdCommand, /PartitionStyle -ne 'GPT'/);
  assert.match(plan.bcdCommand, /winload\.efi/);
  assert.match(plan.bcdCommand, /Add-PartitionAccessPath/);
  assert.ok(plan.bcdCommand.includes(String.raw`bcdboot "$($winL):\Windows" /s "$($espL):" /f UEFI`));
  assert.ok(plan.bcdCommand.includes('} } finally { Remove-PartitionAccessPath'), 'try et finally doivent se suivre sans point-virgule');
  assert.doesNotMatch(plan.bcdCommand, /\}\s*;\s*finally/);
  assert.doesNotMatch(plan.bcdCommand, /bcdboot Z:/);
  assert.throws(() => advancedTools.buildMigrateOsCommands(2, 2), /différent/);
});

test('R.4 surface test offers quick and full modes only', () => {
  assert.deepEqual(advancedTools.buildWorkerArgs('surface', { diskNumber: 2, mode: 'full' }), ['surface', '--disk', '2', '--segments', '192', '--mode', 'full']);
  assert.throws(() => advancedTools.buildWorkerArgs('surface', { diskNumber: 2, mode: 'write' }), /Mode de test de surface inconnu/);
});

test('R.5 DiskWorker uses 4096-aligned native buffers, RandomAccess I/O and regenerates the disk identity', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'native', 'FClonedisk.DiskWorker', 'Program.cs'), 'utf8');
  assert.match(src, /NativeMemory\.AlignedAlloc\(\(nuint\)length, ALIGNMENT\)/);
  assert.match(src, /RandomAccess\.Write\(/);
  assert.doesNotMatch(src, /new FileStream\(/);
  assert.match(src, /RegenerateDiskIdentity\(dst, src\.Length\)/);
  assert.match(src, /if \(status == "bad"\) badCount\+\+;/);
  const csproj = fs.readFileSync(path.join(process.cwd(), 'native', 'FClonedisk.DiskWorker', 'FClonedisk.DiskWorker.csproj'), 'utf8');
  assert.match(csproj, /<AllowUnsafeBlocks>true<\/AllowUnsafeBlocks>/);
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.extraResources[0], { from: 'electron/bin', to: 'worker', filter: ['FClonedisk.DiskWorker.exe'] });
});
