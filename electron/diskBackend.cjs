const { execFile } = require('child_process');
const os = require('os');

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
]);

const ALLOWED_WINDOWS_FS = new Set(['NTFS', 'FAT32', 'exFAT', 'ReFS']);
const DRIVE_LETTER_RE = /^[C-Z]$/i;

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

function sanitizeVolumeLabel(raw) {
  const str = typeof raw === 'string' ? raw.replace(/[\r\n\t\0]/g, '').slice(0, 32) : '';
  // Escape single quotes for PowerShell single-quoted literal
  return str.replace(/'/g, "''");
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
      return `mbr2gpt /convert /disk:${diskNumber} /allowFullOS`;

    case 'check_partition': {
      const letter = sanitizeDriveLetter(params.letter, true);
      return `Repair-Volume -DriveLetter ${letter} -Scan`;
    }

    case 'wipe_disk':
      return `Clear-Disk -Number ${diskNumber} -RemoveData -RemoveOEM -Confirm:$false`;

    default:
      throw new Error(`Opération non prise en charge : ${String(op.type)}`);
  }
}

/**
 * Normalizes raw PowerShell disk JSON into the exact frontend Disk[] schema,
 * including real Unallocated gap calculation from offsets.
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
    let cursorBytes = 1024 * 1024; // 1 MB initial alignment offset
    const MIN_GAP_BYTES = 128 * 1024 * 1024; // Ignore < 128 MB alignment gaps

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
      serial: d.serial || 'N/A',
      busType: ['NVMe', 'SATA', 'USB', 'SAS'].includes(d.busType) ? d.busType : 'SATA',
      mediaType: d.mediaType === 'HDD' ? 'HDD' : d.busType === 'USB' ? 'Removable' : 'SSD',
      partitionStyle: d.partitionStyle === 'MBR' ? 'MBR' : 'GPT',
      sizeGB: diskSizeGB,
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
    return { supported: true, disks: mapWindowsDisksToModel(parsed) };
  } catch (err) {
    return { supported: false, disks: [], reason: err.message };
  }
}

async function assertNotSystemTarget(op) {
  if (!['wipe_disk', 'delete', 'format'].includes(op.type)) return;
  const diskNum = assertNonNegativeInt(op.diskNumber, 'diskNumber');
  const checkScript = `
    $parts = Get-Partition -DiskNumber ${diskNum} -ErrorAction SilentlyContinue
    $sys = $parts | Where-Object { $_.IsSystem -or $_.IsBoot }
    if ($sys) { "SYSTEM" } else { "SAFE" }
  `;
  const status = await runPowerShell(checkScript);
  if (op.type === 'wipe_disk' && status === 'SYSTEM') {
    throw new Error(`Protection système : effacement du Disque ${diskNum} bloqué car il contient Windows / la partition d'amorçage.`);
  }
  if ((op.type === 'delete' || op.type === 'format') && op.partitionNumber) {
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

  const results = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    let cmd = '';
    try {
      cmd = buildWindowsCommand(op);
      await assertNotSystemTarget(op);

      onProgress({
        index: i,
        total: operations.length,
        operationId: op.id,
        status: 'running',
        command: cmd,
        percent: Math.round((i / operations.length) * 100),
      });

      const output = await runPowerShell(cmd);
      results.push({ id: op.id, ok: true, command: cmd, output });
      onProgress({
        index: i,
        total: operations.length,
        operationId: op.id,
        status: 'done',
        command: cmd,
        output,
        percent: Math.round(((i + 1) / operations.length) * 100),
      });
    } catch (err) {
      results.push({ id: op.id, ok: false, command: cmd || op.type, error: err.message });
      onProgress({
        index: i,
        total: operations.length,
        operationId: op.id,
        status: 'error',
        command: cmd || op.type,
        error: err.message,
        percent: Math.round(((i + 1) / operations.length) * 100),
      });
      break;
    }
  }
  return results;
}

module.exports = {
  REAL_WINDOWS_SUPPORTED_OPS,
  buildWindowsCommand,
  mapWindowsDisksToModel,
  getSystemInfo,
  listWindowsDisks,
  executeOperations,
};
