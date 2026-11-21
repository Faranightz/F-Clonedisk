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
    type: 'clone_disk', // unsupported in native Windows mode
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
