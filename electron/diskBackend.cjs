const { execFile } = require('child_process');
const os = require('os');
const advancedTools = require('./advancedTools.cjs');

const REAL_WINDOWS_SUPPORTED_OPS = new Set([
  'create',
  'resize',
  'format',
  'delete',
  'letter',
  'label',
  'convert_gpt',
  'check_partition',
  'wipe_disk',
  'clone_disk',
  'migrate_os',
  'backup_vhdx',
  'app_mover',
]);

const ALLOWED_WINDOWS_FS = new Set(['NTFS', 'FAT32', 'exFAT', 'ReFS']);
const DRIVE_LETTER_RE = /^[C-Z]$/i;
// Strict whitelist: ASCII letters, digits, space, hyphen, underscore (max 32 chars).
// Rejects all quotes (' ‘ ’ ‚ ‛ › ") and PowerShell metacharacters ($ ` ; | &).
const VOLUME_LABEL_RE = /^[A-Za-z0-9 _-]{0,32}$/;

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

function assertNonNegativeInt(val, fieldName) {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 255) {
    throw new Error(`Paramètre invalide (${fieldName}) : entier attendu.`);
  }
  return val;
}

function assertPositiveInt(val, fieldName) {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 128) {
    throw new Error(`Paramètre invalide (${fieldName}) : entier positif attendu.`);
  }
  return val;
}

function sanitizeDriveLetter(raw, required = false) {
  const cleaned = typeof raw === 'string' ? raw.trim().replace(/:$/, '').toUpperCase() : '';
  if (!cleaned) {
    if (required) throw new Error('Lettre de lecteur requise et manquante.');
    return '';
  }
  if (!DRIVE_LETTER_RE.test(cleaned)) {
    throw new Error(`Lettre de lecteur invalide : "${raw}".`);
  }
  return cleaned;
}

/**
 * Strictly validates a volume label: only ASCII letters, digits, space, hyphen, underscore (max 32 chars).
 * Explicitly rejects straight and typographic quotes (' ‘ ’ ‚ ‛ › ") and PowerShell metacharacters.
 */
function sanitizeVolumeLabel(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new Error('Nom de volume invalide : chaîne de caractères attendue.');
  }
  const trimmed = raw.trim();
  if (!VOLUME_LABEL_RE.test(trimmed)) {
    throw new Error(
      'Nom de volume invalide : seuls les lettres sans accent (A-Z), chiffres (0-9), espaces, tirets (-) et underscores (_) sont autorisés (max 32 caractères, aucun guillemet ni caractère spécial).'
    );
  }
  return trimmed;
}

function assertAllowedFileSystem(fs, sizeGB) {
  if (typeof fs !== 'string' || !ALLOWED_WINDOWS_FS.has(fs)) {
    throw new Error(
      `Système de fichiers "${fs}" non pris en charge par Format-Volume sous Windows natif (supportés : NTFS, FAT32, exFAT, ReFS).`
    );
  }
  if (fs === 'FAT32' && typeof sizeGB === 'number' && sizeGB > 32) {
    throw new Error('Format-Volume Windows limite FAT32 à 32 Go maximum en mode natif.');
  }
  return fs;
}

function validateDiskIdentity(identity, expectedDiskNumber) {
  if (!identity || typeof identity !== 'object') {
    throw new Error(`Identité du disque manquante (SerialNumber/UniqueId et taille requis pour Disque ${expectedDiskNumber}).`);
  }
  const model = typeof identity.model === 'string' ? identity.model.trim() : '';
  const serial = typeof identity.serial === 'string' ? identity.serial.trim() : '';
  const uniqueId = typeof identity.uniqueId === 'string' ? identity.uniqueId.trim() : '';
  const sizeBytes = Number(identity.sizeBytes);
  const sizeGB = Number(identity.sizeGB);

  if (!serial && !uniqueId) {
    throw new Error(`Identité du disque incomplète pour Disque ${expectedDiskNumber} : SerialNumber ou UniqueId requis.`);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Identité du disque incomplète pour Disque ${expectedDiskNumber} : taille invalide.`);
  }
  return {
    diskNumber: expectedDiskNumber,
    model: model || `Disque ${expectedDiskNumber}`,
    serial: serial || 'N/A',
    uniqueId,
    sizeBytes,
    sizeGB: Number.isFinite(sizeGB) && sizeGB > 0 ? sizeGB : Number((sizeBytes / 1024 ** 3).toFixed(2)),
  };
}

/**
 * Compares the expected disk identity sent by the UI with the live disk returned by Windows.
 * Throws immediately on any mismatch to prevent acting on a renumbered or swapped drive.
 */
function verifyDiskIdentity(expected, actual) {
  if (!actual || typeof actual !== 'object') {
    throw new Error(`Disque ${expected.diskNumber} introuvable lors de la vérification d'identité.`);
  }
  const expectedUid = (expected.uniqueId || '').trim();
  const actualUid = (actual.uniqueId || '').trim();
  if (expectedUid && actualUid && expectedUid !== actualUid) {
    throw new Error(
      `Identité du Disque ${expected.diskNumber} modifiée (UniqueId attendu "${expectedUid}", trouvé "${actualUid}"). Exécution bloquée.`
    );
  }

  const expectedSerial = (expected.serial || '').trim();
  const actualSerial = (actual.serial || '').trim();
  if (expectedSerial && expectedSerial !== 'N/A' && actualSerial && expectedSerial !== actualSerial) {
    throw new Error(
      `Numéro de série du Disque ${expected.diskNumber} différent (attendu "${expectedSerial}", trouvé "${actualSerial}"). Exécution bloquée.`
    );
  }

  const actualSizeBytes = Number(actual.sizeBytes);
  const expectedSizeBytes = Number(expected.sizeBytes);
  const SIZE_TOLERANCE_BYTES = 16 * 1024 * 1024; // 16 MB tolerance for rounding
  if (
    !Number.isFinite(actualSizeBytes) ||
    Math.abs(actualSizeBytes - expectedSizeBytes) > SIZE_TOLERANCE_BYTES
  ) {
    throw new Error(
      `Taille du Disque ${expected.diskNumber} différente (attendue ${expectedSizeBytes} octets, trouvée ${actualSizeBytes} octets). Exécution bloquée.`
    );
  }
}

/**
 * Verifies a partition retrieved by drive letter against the declared diskNumber and system protection.
 */
function verifyPartitionByLetter(op, actualPart) {
  const letter = sanitizeDriveLetter(
    op.type === 'letter' ? (op.params.oldLetter || op.params.letter) : op.params.letter,
    true
  );
  if (!actualPart || typeof actualPart !== 'object') {
    throw new Error(`Partition introuvable pour la lettre ${letter}:.`);
  }
  if (Number(actualPart.diskNumber) !== Number(op.diskNumber)) {
    throw new Error(
      `Incohérence de disque pour ${letter}: — annoncé sur Disque ${op.diskNumber}, mais réellement sur Disque ${actualPart.diskNumber}. Exécution bloquée.`
    );
  }
  const blocksSystem = op.type === 'format' || op.type === 'letter';
  if (blocksSystem && (actualPart.isSystem || actualPart.isBoot)) {
    throw new Error(
      `Protection système : impossible d'exécuter "${op.type}" sur ${letter}: car cette partition est une partition système/d'amorçage (IsSystem/IsBoot).`
    );
  }
}

/**
 * Strictly validates an operation object and returns a safe PowerShell command.
 * Rejects any unsupported operation or invalid parameter (zero silent fallbacks).
 */
function buildWindowsCommand(op) {
  if (!op || typeof op !== 'object') {
    throw new Error('Opération invalide.');
  }
  if (!REAL_WINDOWS_SUPPORTED_OPS.has(op.type)) {
    throw new Error(
      `L'opération "${String(op.type)}" est disponible uniquement en Mode Simulation (non implémentée dans le backend Windows natif).`
    );
  }

  const diskNumber = assertNonNegativeInt(op.diskNumber, 'diskNumber');
  const params = op.params && typeof op.params === 'object' ? op.params : {};

  switch (op.type) {
    case 'create': {
      const sizeGB = Number(params.sizeGB);
      if (!Number.isFinite(sizeGB) || sizeGB < 0.1 || sizeGB > 65536) {
        throw new Error('Taille de partition invalide.');
      }
      const fs = assertAllowedFileSystem(params.fileSystem, sizeGB);
      const letter = sanitizeDriveLetter(params.letter, false);
      const label = sanitizeVolumeLabel(params.label || 'Nouveau');
      const sizeBytes = Math.round(sizeGB * 1024 * 1024 * 1024);
      const letterArg = letter ? `-DriveLetter ${letter}` : '-AssignDriveLetter';
      return `New-Partition -DiskNumber ${diskNumber} -Size ${sizeBytes} ${letterArg} | Format-Volume -FileSystem ${fs} -NewFileSystemLabel '${label}' -Confirm:$false`;
    }

    case 'resize': {
      const partitionNumber = assertPositiveInt(op.partitionNumber, 'partitionNumber');
      const newSizeGB = Number(params.newSizeGB);
      if (!Number.isFinite(newSizeGB) || newSizeGB < 0.1 || newSizeGB > 65536) {
        throw new Error('Nouvelle taille invalide.');
      }
      const sizeBytes = Math.round(newSizeGB * 1024 * 1024 * 1024);
      return `Resize-Partition -DiskNumber ${diskNumber} -PartitionNumber ${partitionNumber} -Size ${sizeBytes}`;
    }

    case 'format': {
      const letter = sanitizeDriveLetter(params.letter, true);
      const fs = assertAllowedFileSystem(params.fileSystem, params.sizeGB);
      const label = sanitizeVolumeLabel(params.label || '');
      return `Format-Volume -DriveLetter ${letter} -FileSystem ${fs} -NewFileSystemLabel '${label}' -Confirm:$false`;
    }

    case 'delete': {
      const partitionNumber = assertPositiveInt(op.partitionNumber, 'partitionNumber');
      return `Remove-Partition -DiskNumber ${diskNumber} -PartitionNumber ${partitionNumber} -Confirm:$false`;
    }

    case 'letter': {
      const partitionNumber = assertPositiveInt(op.partitionNumber, 'partitionNumber');
      const newLetter = sanitizeDriveLetter(params.newLetter, false);
      if (!newLetter) {
        const oldLetter = sanitizeDriveLetter(params.oldLetter, true);
        return `Remove-PartitionAccessPath -DiskNumber ${diskNumber} -PartitionNumber ${partitionNumber} -AccessPath '${oldLetter}:\\'`;
      }
      return `Set-Partition -DiskNumber ${diskNumber} -PartitionNumber ${partitionNumber} -NewDriveLetter ${newLetter}`;
    }

    case 'label': {
      const letter = sanitizeDriveLetter(params.letter, true);
      const label = sanitizeVolumeLabel(params.newLabel || '');
      return `Set-Volume -DriveLetter ${letter} -NewFileSystemLabel '${label}'`;
    }

    case 'convert_gpt':
      return `mbr2gpt /validate /disk:${diskNumber} /allowFullOS; if ($LASTEXITCODE -ne 0) { throw "Validation MBR2GPT échouée (code $LASTEXITCODE)." }; mbr2gpt /convert /disk:${diskNumber} /allowFullOS`;

    case 'check_partition': {
      const letter = sanitizeDriveLetter(params.letter, true);
      return `Repair-Volume -DriveLetter ${letter} -Scan`;
    }

    case 'wipe_disk': {
      if (params.method) {
        const wArgs = advancedTools.buildWorkerArgs('wipe', { diskNumber, method: params.method });
        return `FClonedisk.DiskWorker.exe ${wArgs.join(' ')}`;
      }
      return `Clear-Disk -Number ${diskNumber} -RemoveData -RemoveOEM -Confirm:$false`;
    }

    case 'clone_disk': {
      const wArgs = advancedTools.buildWorkerArgs('clone', {
        sourceDiskNumber: params.sourceDiskNumber,
        targetDiskNumber: params.targetDiskNumber ?? diskNumber,
      });
      return `FClonedisk.DiskWorker.exe ${wArgs.join(' ')}`;
    }

    case 'migrate_os': {
      const plan = advancedTools.buildMigrateOsCommands(
        params.sourceDiskNumber,
        params.targetDiskNumber ?? diskNumber,
        params.targetOsLetter || 'Z',
        params.targetEfiLetter || 'S'
      );
      return `FClonedisk.DiskWorker.exe ${plan.workerArgs.join(' ')} && ${plan.bcdCommand}`;
    }

    case 'backup_vhdx':
      return advancedTools.buildBackupCommand(params);

    case 'app_mover': {
      const paths = Array.isArray(params.sourcePaths) ? params.sourcePaths : params.sourcePath ? [params.sourcePath] : [];
      if (paths.length === 0) throw new Error('Aucun chemin source spécifié pour App Mover.');
      return paths.map((p) => advancedTools.buildAppMoverScript(p, params.targetDrive)).join('; ');
    }

    default:
      throw new Error(`Opération non prise en charge : ${String(op.type)}`);
  }
}

/**
 * Validates the ENTIRE operation queue and builds ALL PowerShell commands before anything executes.
 * If even one operation is invalid, throws immediately and nothing runs.
 */
function prepareOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 50) {
    throw new Error('File d’opérations vide ou invalide.');
  }
  const prepared = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const diskNumber = assertNonNegativeInt(op?.diskNumber, `operations[${i}].diskNumber`);
    const diskIdentity = validateDiskIdentity(op.diskIdentity, diskNumber);
    const command = buildWindowsCommand(op);
    prepared.push({ op, diskIdentity, command });
  }
  return prepared;
}

/**
 * Formats the native Electron confirmation dialog detail showing the real disk model,
 * serial number, size, and exact PowerShell command (never op.title).
 */
function formatConfirmationSummary(preparedOps) {
  const hasConvertGpt = preparedOps.some((p) => p.op.type === 'convert_gpt');
  const lines = preparedOps.map((item, idx) => {
    const id = item.diskIdentity;
    const serialText = id.serial !== 'N/A' ? id.serial : id.uniqueId || 'Inconnu';
    return [
      `${idx + 1}. Disque ${id.diskNumber} — ${id.model} | S/N: ${serialText} | ${id.sizeGB} Go`,
      `   Commande : ${item.command}`,
    ].join('\n');
  });
  if (hasConvertGpt) {
    lines.push(
      '\nIMPORTANT (MBR -> GPT) : passez le BIOS en mode UEFI avant de redémarrer Windows.'
    );
  }
  return lines.join('\n\n');
}

/**
 * Normalizes raw PowerShell disk JSON into the exact frontend Disk[] schema,
 * including real Unallocated gap calculation from offsets, UniqueId, and SizeBytes.
 */
function mapWindowsDisksToModel(rawDisks) {
  const arr = Array.isArray(rawDisks) ? rawDisks : rawDisks ? [rawDisks] : [];
  return arr.map((d) => {
    const diskNum = Number(d.number ?? 0);
    const diskSizeBytes = Number(d.sizeBytes || (d.sizeGB || 0) * 1024 ** 3);
    const diskSizeGB = Number((diskSizeBytes / 1024 ** 3).toFixed(2));
    const rawParts = Array.isArray(d.partitions) ? d.partitions : d.partitions ? [d.partitions] : [];
    const sorted = [...rawParts].sort((a, b) => Number(a.offsetBytes || 0) - Number(b.offsetBytes || 0));

    const partitions = [];
    let cursorBytes = 1024 * 1024;
    const MIN_GAP_BYTES = 128 * 1024 * 1024;

    for (const p of sorted) {
      const pOffset = Number(p.offsetBytes || cursorBytes);
      const pSizeBytes = Number(p.sizeBytes || (p.sizeGB || 0) * 1024 ** 3);

      if (pOffset - cursorBytes >= MIN_GAP_BYTES) {
        const gapGB = Number(((pOffset - cursorBytes) / 1024 ** 3).toFixed(2));
        partitions.push({
          id: `win-d${diskNum}-unalloc-${cursorBytes}`,
          partitionNumber: 0,
          letter: '',
          label: 'Non alloué',
          fileSystem: 'Unallocated',
          sizeGB: gapGB,
          usedGB: 0,
          role: 'Unallocated',
          aligned4K: true,
          clusterSize: '-',
        });
      }

      const roleMap = {
        System: 'EFI',
        Recovery: 'Recovery',
        Basic: p.isSystem ? 'System' : 'Primary',
        Logical: 'Logical',
      };

      partitions.push({
        id: `win-d${diskNum}-p${p.partitionNumber}`,
        partitionNumber: Number(p.partitionNumber),
        letter: p.letter || '',
        label: p.label || 'Volume',
        fileSystem: p.fileSystem || 'RAW',
        sizeGB: Number((pSizeBytes / 1024 ** 3).toFixed(2)),
        usedGB: Number(p.usedGB || 0),
        role: roleMap[p.type] || (p.isSystem ? 'System' : 'Primary'),
        isSystem: Boolean(p.isSystem),
        isActive: Boolean(p.isActive),
        isHidden: Boolean(p.isHidden),
        aligned4K: Boolean(p.aligned4K),
        clusterSize: p.clusterSize || '4 Ko',
      });

      cursorBytes = Math.max(cursorBytes, pOffset + pSizeBytes);
    }

    if (diskSizeBytes - cursorBytes >= MIN_GAP_BYTES) {
      partitions.push({
        id: `win-d${diskNum}-unalloc-tail`,
        partitionNumber: 0,
        letter: '',
        label: 'Non alloué',
        fileSystem: 'Unallocated',
        sizeGB: Number(((diskSizeBytes - cursorBytes) / 1024 ** 3).toFixed(2)),
        usedGB: 0,
        role: 'Unallocated',
        aligned4K: true,
        clusterSize: '-',
      });
    }

    const healthRaw = String(d.health || '').toLowerCase();
    const health = healthRaw === 'healthy' ? 'Sain' : healthRaw === 'warning' ? 'Avertissement' : 'Critique';
    const status = String(d.status || '').toLowerCase() === 'online' ? 'En ligne' : 'Hors ligne';
    const wear = typeof d.wear === 'number' ? d.wear : null;

    return {
      id: `win-disk-${diskNum}`,
      number: diskNum,
      model: d.model || `Disque physique ${diskNum}`,
      serial: d.serial ? String(d.serial).trim() : 'N/A',
      uniqueId: d.uniqueId ? String(d.uniqueId).trim() : '',
      busType: ['NVMe', 'SATA', 'USB', 'SAS'].includes(d.busType) ? d.busType : 'SATA',
      mediaType: d.mediaType === 'HDD' ? 'HDD' : d.busType === 'USB' ? 'Removable' : 'SSD',
      partitionStyle: d.partitionStyle === 'MBR' ? 'MBR' : 'GPT',
      sizeGB: diskSizeGB,
      sizeBytes: diskSizeBytes,
      status,
      health,
      smart: {
        healthPercent: wear !== null ? Math.max(0, 100 - wear) : health === 'Sain' ? 100 : 75,
        temperatureC: typeof d.temperature === 'number' ? d.temperature : null,
        powerOnHours: typeof d.powerOnHours === 'number' ? d.powerOnHours : null,
        powerCycles: null,
        totalWrittenTB: null,
        reallocatedSectors: typeof d.readErrors === 'number' ? d.readErrors : 0,
        pendingSectors: 0,
        unsafeShutdowns: 0,
        wearLevelPercent: wear,
      },
      partitions,
    };
  });
}

async function getSystemInfo() {
  const isWindows = process.platform === 'win32';
  let isAdmin = false;

  if (isWindows) {
    try {
      const out = await runPowerShell(
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      );
      isAdmin = out.toLowerCase() === 'true';
    } catch {
      isAdmin = false;
    }
  }

  return {
    platform: process.platform,
    hostname: os.hostname(),
    arch: os.arch(),
    totalMemoryGB: Math.round(os.totalmem() / 1024 ** 3),
    isWindows,
    isAdmin,
  };
}

async function listWindowsDisks() {
  if (process.platform !== 'win32') {
    return { supported: false, disks: [], reason: 'Mode Windows requis pour la lecture matérielle directe.' };
  }

  const psScript = `
    $disks = Get-Disk | Sort-Object Number
    $phys = Get-PhysicalDisk -ErrorAction SilentlyContinue
    $result = @()
    foreach ($d in $disks) {
      $pDisk = $phys | Where-Object { $_.DeviceId -eq "$($d.Number)" } | Select-Object -First 1
      $smart = $null
      if ($pDisk) {
        $smart = $pDisk | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
      }
      $parts = Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | Sort-Object Offset
      $partList = @()
      foreach ($p in $parts) {
        $vol = $p | Get-Volume -ErrorAction SilentlyContinue
        $sizeGB = [math]::Round($p.Size / 1GB, 2)
        $freeGB = if ($vol -and $null -ne $vol.SizeRemaining) { [math]::Round($vol.SizeRemaining / 1GB, 2) } else { 0 }
        $usedGB = [math]::Max(0, [math]::Round($sizeGB - $freeGB, 2))
        $partList += [PSCustomObject]@{
          partitionNumber = $p.PartitionNumber
          letter = if ($p.DriveLetter) { "$($p.DriveLetter):" } else { "" }
          label = if ($vol -and $vol.FileSystemLabel) { $vol.FileSystemLabel } elseif ($p.Type -eq 'System') { "EFI System" } elseif ($p.Type -eq 'Recovery') { "Récupération" } else { "Volume" }
          fileSystem = if ($vol -and $vol.FileSystem) { $vol.FileSystem } elseif ($p.Type -eq 'System') { "FAT32" } else { "RAW" }
          sizeBytes = $p.Size
          sizeGB = $sizeGB
          usedGB = $usedGB
          offsetBytes = $p.Offset
          isSystem = ($p.IsSystem -or $p.IsBoot)
          isActive = $p.IsActive
          isHidden = $p.IsHidden
          type = "$($p.Type)"
          aligned4K = (($p.Offset % 4096) -eq 0)
        }
      }
      $result += [PSCustomObject]@{
        number = $d.Number
        model = $d.FriendlyName
        serial = $d.SerialNumber
        uniqueId = $d.UniqueId
        busType = "$($d.BusType)"
        mediaType = if ($pDisk) { "$($pDisk.MediaType)" } else { "SSD" }
        partitionStyle = "$($d.PartitionStyle)"
        sizeBytes = $d.Size
        sizeGB = [math]::Round($d.Size / 1GB, 2)
        status = "$($d.OperationalStatus)"
        health = "$($d.HealthStatus)"
        temperature = if ($smart -and $null -ne $smart.Temperature) { $smart.Temperature } else { $null }
        wear = if ($smart -and $null -ne $smart.Wear) { $smart.Wear } else { $null }
        powerOnHours = if ($smart -and $null -ne $smart.PowerOnHours) { $smart.PowerOnHours } else { $null }
        readErrors = if ($smart -and $null -ne $smart.ReadErrorsTotal) { $smart.ReadErrorsTotal } else { $null }
        partitions = $partList
      }
    }
    $result | ConvertTo-Json -Depth 6
  `;

  try {
    const raw = await runPowerShell(psScript);
    if (!raw) return { supported: true, disks: [] };
    const parsed = JSON.parse(raw);
    const mapped = mapWindowsDisksToModel(parsed);
    // Enrich SMART data via smartctl if installed on the host
    for (const disk of mapped) {
      const extSmart = await advancedTools.readSmartWithSmartctl(disk.number);
      if (extSmart) {
        disk.smart = {
          ...disk.smart,
          ...extSmart,
        };
      }
    }
    return { supported: true, disks: mapped };
  } catch (err) {
    return { supported: false, disks: [], reason: err.message };
  }
}

async function assertDiskIdentityMatches(diskIdentity) {
  const diskNum = assertNonNegativeInt(diskIdentity.diskNumber, 'diskNumber');
  const raw = await runPowerShell(
    `$d = Get-Disk -Number ${diskNum} -ErrorAction Stop; [PSCustomObject]@{ number=$d.Number; serial=$d.SerialNumber; uniqueId=$d.UniqueId; sizeBytes=$d.Size } | ConvertTo-Json -Compress`
  );
  const actual = JSON.parse(raw);
  verifyDiskIdentity(diskIdentity, actual);
}

async function assertNotSystemTarget(op) {
  const diskNum = assertNonNegativeInt(op.diskNumber, 'diskNumber');

  // For format, letter removal/change, label, and check_partition: look up by DriveLetter
  if (op.type === 'format' || op.type === 'label' || op.type === 'check_partition' || (op.type === 'letter' && op.params?.oldLetter)) {
    const letter = sanitizeDriveLetter(
      op.type === 'letter' ? op.params.oldLetter : op.params.letter,
      true
    );
    const raw = await runPowerShell(
      `$p = Get-Partition -DriveLetter ${letter} -ErrorAction Stop; [PSCustomObject]@{ diskNumber=$p.DiskNumber; partitionNumber=$p.PartitionNumber; isSystem=$p.IsSystem; isBoot=$p.IsBoot } | ConvertTo-Json -Compress`
    );
    const actualPart = JSON.parse(raw);
    verifyPartitionByLetter(op, actualPart);
  }

  if (op.type === 'wipe_disk' || op.type === 'clone_disk' || op.type === 'migrate_os') {
    const status = await runPowerShell(
      `$parts = Get-Partition -DiskNumber ${diskNum} -ErrorAction SilentlyContinue; if ($parts | Where-Object { $_.IsSystem -or $_.IsBoot }) { "SYSTEM" } else { "SAFE" }`
    );
    if (status === 'SYSTEM') {
      throw new Error(`Protection système : opération "${op.type}" sur le Disque ${diskNum} bloquée car il contient Windows / la partition d'amorçage.`);
    }
  }

  if ((op.type === 'delete' || op.type === 'letter') && op.partitionNumber) {
    const pNum = assertPositiveInt(op.partitionNumber, 'partitionNumber');
    const pCheck = await runPowerShell(
      `$p = Get-Partition -DiskNumber ${diskNum} -PartitionNumber ${pNum} -ErrorAction SilentlyContinue; if ($p -and ($p.IsSystem -or $p.IsBoot)) { "SYSTEM" } else { "SAFE" }`
    );
    if (pCheck === 'SYSTEM') {
      throw new Error(`Protection système : impossible de modifier/supprimer la partition système Disque ${diskNum} Partition ${pNum}.`);
    }
  }
}

async function executeOperations(operations, onProgress) {
  if (process.platform !== 'win32') {
    throw new Error('Exécution réelle disponible uniquement sous Windows en mode Administrateur.');
  }

  // Step 1.3: Validate ALL operations and build ALL commands BEFORE running anything
  const prepared = prepareOperations(operations);

  const results = [];
  for (let i = 0; i < prepared.length; i++) {
    const { op, diskIdentity, command } = prepared[i];
    try {
      // Step 1.2: Re-verify live disk identity (UniqueId/SerialNumber/Size) right before execution
      await assertDiskIdentityMatches(diskIdentity);
      // Step 1.5: Verify system partition & letter-to-disk consistency right before execution
      await assertNotSystemTarget(op);

      onProgress({
        index: i,
        total: prepared.length,
        operationId: op.id,
        status: 'running',
        command,
        percent: Math.round((i / prepared.length) * 100),
      });

      let output = '';
      if (op.type === 'wipe_disk' && op.params?.method) {
        const res = await advancedTools.runDiskWorker('wipe', { diskNumber: op.diskNumber, method: op.params.method }, (ev) => {
          if (ev.type === 'progress') {
            onProgress({ index: i, total: prepared.length, operationId: op.id, status: 'running', command: `${command} (${ev.mbPerSec} Mo/s)`, percent: Math.round(ev.percent) });
          }
        });
        output = JSON.stringify(res);
      } else if (op.type === 'clone_disk') {
        const res = await advancedTools.runDiskWorker('clone', { sourceDiskNumber: op.params.sourceDiskNumber, targetDiskNumber: op.params.targetDiskNumber ?? op.diskNumber }, (ev) => {
          if (ev.type === 'progress') {
            onProgress({ index: i, total: prepared.length, operationId: op.id, status: 'running', command: `${command} (${ev.mbPerSec} Mo/s)`, percent: Math.round(ev.percent) });
          }
        });
        output = JSON.stringify(res);
      } else if (op.type === 'migrate_os') {
        const plan = advancedTools.buildMigrateOsCommands(op.params.sourceDiskNumber, op.params.targetDiskNumber ?? op.diskNumber, op.params.targetOsLetter || 'Z', op.params.targetEfiLetter || 'S');
        await advancedTools.runDiskWorker('clone', { sourceDiskNumber: op.params.sourceDiskNumber, targetDiskNumber: op.params.targetDiskNumber ?? op.diskNumber }, (ev) => {
          if (ev.type === 'progress') {
            onProgress({ index: i, total: prepared.length, operationId: op.id, status: 'running', command: `${command} (${ev.mbPerSec} Mo/s)`, percent: Math.round(ev.percent * 0.9) });
          }
        });
        output = await runPowerShell(plan.bcdCommand);
      } else {
        output = await runPowerShell(command);
      }

      results.push({ id: op.id, ok: true, command, output });
      onProgress({
        index: i,
        total: prepared.length,
        operationId: op.id,
        status: 'done',
        command,
        output,
        percent: Math.round(((i + 1) / prepared.length) * 100),
      });
    } catch (err) {
      results.push({ id: op.id, ok: false, command, error: err.message });
      onProgress({
        index: i,
        total: prepared.length,
        operationId: op.id,
        status: 'error',
        command,
        error: err.message,
        percent: Math.round(((i + 1) / prepared.length) * 100),
      });
      break;
    }
  }
  return results;
}

module.exports = {
  REAL_WINDOWS_SUPPORTED_OPS,
  sanitizeVolumeLabel,
  validateDiskIdentity,
  verifyDiskIdentity,
  verifyPartitionByLetter,
  buildWindowsCommand,
  prepareOperations,
  formatConfirmationSummary,
  mapWindowsDisksToModel,
  getSystemInfo,
  listWindowsDisks,
  executeOperations,
};
