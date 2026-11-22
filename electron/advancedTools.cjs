const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ALLOWED_WIPE_METHODS = new Set(['zero', 'random', 'dod3', 'dod7']);
const DRIVE_LETTER_RE = /^[C-Z]$/i;
const WINDOWS_SAFE_PATH_RE = /^[C-Z]:\\[A-Za-z0-9 _().\\-]{1,240}$/;
const PROTECTED_APP_PATHS = [
  /^C:\\Windows(\\|$)/i,
  /^C:\\System Volume Information(\\|$)/i,
  /^C:\\ProgramData(\\|$)/i,
  /^C:\\Users(\\|$)/i,
  /^C:\\$/i,
];

function assertDiskNum(val, name = 'diskNumber') {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 255) {
    throw new Error(`Numéro de disque invalide (${name}).`);
  }
  return val;
}

function sanitizeLetter(raw) {
  const cleaned = typeof raw === 'string' ? raw.trim().replace(/:$/, '').toUpperCase() : '';
  if (!DRIVE_LETTER_RE.test(cleaned)) {
    throw new Error(`Lettre de lecteur invalide : "${raw}".`);
  }
  return cleaned;
}

/**
 * Resolves the compiled FClonedisk.DiskWorker.exe path on Windows.
 */
function locateDiskWorker() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'worker', 'FClonedisk.DiskWorker.exe') : null,
    path.join(__dirname, 'bin', 'FClonedisk.DiskWorker.exe'),
    path.join(__dirname, '..', 'native', 'FClonedisk.DiskWorker', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'FClonedisk.DiskWorker.exe'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Strictly validates and constructs CLI arguments for FClonedisk.DiskWorker.exe.
 */
function buildWorkerArgs(command, params = {}) {
  if (command === 'wipe') {
    const disk = assertDiskNum(params.diskNumber, 'diskNumber');
    const methodMap = {
      zero: 'zero',
      random: 'random',
      dod3: 'dod3',
      dod7: 'dod7',
      'Remplissage par zéros (1 passe - Rapide)': 'zero',
      'Données aléatoires (1 passe)': 'random',
      'DoD 5220.22-M (3 passes - Militaire US)': 'dod3',
      'DoD 5220.22-ECE (7 passes)': 'dod7',
    };
    const method = methodMap[params.method];
    if (!method || !ALLOWED_WIPE_METHODS.has(method)) {
      throw new Error(`Méthode d'effacement non supportée par DiskWorker : "${params.method}".`);
    }
    return ['wipe', '--disk', String(disk), '--method', method];
  }

  if (command === 'clone') {
    const src = assertDiskNum(params.sourceDiskNumber, 'sourceDiskNumber');
    const dst = assertDiskNum(params.targetDiskNumber, 'targetDiskNumber');
    if (src === dst) throw new Error('Les disques source et cible doivent être différents.');
    return ['clone', '--src', String(src), '--dst', String(dst)];
  }

  if (command === 'surface') {
    const disk = assertDiskNum(params.diskNumber, 'diskNumber');
    const segments = Number.isInteger(params.segments) && params.segments >= 16 && params.segments <= 512 ? params.segments : 192;
    const mode = params.mode === undefined ? 'quick' : params.mode;
    if (mode !== 'quick' && mode !== 'full') {
      throw new Error(`Mode de test de surface inconnu : "${mode}" (quick ou full).`);
    }
    return ['surface', '--disk', String(disk), '--segments', String(segments), '--mode', mode];
  }

  throw new Error(`Commande DiskWorker inconnue : "${command}".`);
}

function runDiskWorker(command, params, onEvent) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('FClonedisk.DiskWorker.exe nécessite Windows x64 en mode Administrateur.'));
      return;
    }
    const workerPath = locateDiskWorker();
    if (!workerPath) {
      reject(new Error('FClonedisk.DiskWorker.exe introuvable. Compilez-le sur Windows avec "npm run build:worker".'));
      return;
    }

    let args;
    try {
      args = buildWorkerArgs(command, params);
    } catch (err) {
      reject(err);
      return;
    }

    const child = spawn(workerPath, args, { windowsHide: true, shell: false });
    let stdoutBuf = '';
    let lastError = '';
    let finalPayload = null;

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'done') finalPayload = parsed;
          if (onEvent) onEvent(parsed);
        } catch {
          // ignore non-JSON diagnostic line
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      lastError += chunk.toString('utf8');
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(finalPayload || { ok: true });
      } else {
        reject(new Error(lastError.trim() || `FClonedisk.DiskWorker a échoué (code ${code}).`));
      }
    });
  });
}

/**
 * Parses smartctl -j -a JSON output into F-Clonedisk SmartMetrics.
 */
function parseSmartctlJson(rawJson) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  if (!data || typeof data !== 'object') return null;

  const temp = typeof data.temperature?.current === 'number' ? data.temperature.current : null;
  const hours = typeof data.power_on_time?.hours === 'number' ? data.power_on_time.hours : null;
  const cycles = typeof data.power_cycle_count === 'number' ? data.power_cycle_count : null;

  let wear = null;
  let tbw = null;
  let reallocated = 0;
  let pending = 0;
  let unsafeShutdowns = 0;

  // NVMe health log
  if (data.nvme_smart_health_information_log) {
    const nv = data.nvme_smart_health_information_log;
    if (typeof nv.percentage_used === 'number') wear = nv.percentage_used;
    if (typeof nv.data_units_written === 'number') {
      // 1 data unit = 512,000 bytes
      tbw = Number(((nv.data_units_written * 512000) / 1e12).toFixed(2));
    }
    if (typeof nv.media_errors === 'number') reallocated = nv.media_errors;
    if (typeof nv.unsafe_shutdowns === 'number') unsafeShutdowns = nv.unsafe_shutdowns;
  }

  // ATA SMART attributes table
  if (Array.isArray(data.ata_smart_attributes?.table)) {
    for (const attr of data.ata_smart_attributes.table) {
      if (attr.id === 5 && typeof attr.raw?.value === 'number') reallocated = attr.raw.value;
      if (attr.id === 197 && typeof attr.raw?.value === 'number') pending = attr.raw.value;
      if ((attr.id === 177 || attr.id === 231 || attr.id === 233) && typeof attr.value === 'number') {
        wear = Math.max(0, 100 - attr.value);
      }
    }
  }

  const passed = data.smart_status?.passed !== false;
  return {
    healthPercent: wear !== null ? Math.max(0, 100 - wear) : passed ? 100 : 50,
    temperatureC: temp,
    powerOnHours: hours,
    powerCycles: cycles,
    totalWrittenTB: tbw,
    reallocatedSectors: reallocated,
    pendingSectors: pending,
    unsafeShutdowns,
    wearLevelPercent: wear,
  };
}

function locateSmartctl() {
  const candidates = [
    'C:\\Program Files\\smartmontools\\bin\\smartctl.exe',
    'C:\\Program Files (x86)\\smartmontools\\bin\\smartctl.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'smartctl';
}

function readSmartWithSmartctl(diskNumber) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const num = assertDiskNum(diskNumber);
    execFile(locateSmartctl(), ['-j', '-a', `/dev/pd${num}`], { timeout: 8000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      try {
        resolve(parseSmartctlJson(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Builds Windows ADK WinPE creation commands (copype + MakeWinPEMedia).
 */
function buildWinPeCommands(opts) {
  const mode = opts?.mode === 'ufd' ? 'ufd' : 'iso';
  const workDir = 'C:\\FClonedisk_WinPE_amd64';

  if (mode === 'ufd') {
    const letter = sanitizeLetter(opts.usbLetter);
    if (letter === 'C') throw new Error('Protection système : impossible de créer un média WinPE sur C:.');
    return {
      mode,
      commands: [
        `copype amd64 "${workDir}"`,
        `MakeWinPEMedia /UFD /F "${workDir}" ${letter}:`,
      ],
    };
  }

  const isoPath = typeof opts?.isoPath === 'string' && WINDOWS_SAFE_PATH_RE.test(opts.isoPath) && opts.isoPath.toLowerCase().endsWith('.iso')
    ? opts.isoPath
    : 'C:\\FClonedisk-WinPE-x64.iso';

  return {
    mode,
    commands: [
      `copype amd64 "${workDir}"`,
      `MakeWinPEMedia /ISO /F "${workDir}" "${isoPath}"`,
    ],
  };
}

function locateWindowsAdkWinPe() {
  const adkBase = 'C:\\Program Files (x86)\\Windows Kits\\10\\Assessment and Deployment Kit\\Windows Preinstallation Environment';
  const copype = path.join(adkBase, 'copype.cmd');
  const makeMedia = path.join(adkBase, 'MakeWinPEMedia.cmd');
  if (fs.existsSync(copype) && fs.existsSync(makeMedia)) {
    return { adkBase, copype, makeMedia };
  }
  return null;
}

/**
 * Builds a real Windows backup command (wbadmin or VHDX image via Hyper-V/Storage cmdlets).
 */
function buildBackupCommand(opts) {
  const engine = opts?.engine === 'vhdx' ? 'vhdx' : 'wbadmin';
  const sourceLetter = sanitizeLetter(opts?.sourceDrive || 'C');

  if (engine === 'wbadmin') {
    const targetLetter = sanitizeLetter(opts?.targetDrive);
    if (targetLetter === sourceLetter) {
      throw new Error('Le lecteur cible de sauvegarde doit être différent du lecteur source.');
    }
    return `wbadmin start backup -backupTarget:${targetLetter}: -include:${sourceLetter}: -allCritical -quiet`;
  }

  const vhdxPath = typeof opts?.vhdxPath === 'string' ? opts.vhdxPath.trim() : '';
  if (!WINDOWS_SAFE_PATH_RE.test(vhdxPath) || !vhdxPath.toLowerCase().endsWith('.vhdx')) {
    throw new Error('Chemin VHDX invalide (ex: D:\\Backups\\Windows.vhdx).');
  }
  const sizeGB = Number(opts?.sizeGB);
  if (!Number.isFinite(sizeGB) || sizeGB < 1 || sizeGB > 65536) {
    throw new Error('Taille VHDX invalide.');
  }
  const sizeBytes = Math.round(sizeGB * 1024 ** 3);
  return [
    `$vhd = New-VHD -Path '${vhdxPath}' -SizeBytes ${sizeBytes} -Dynamic`,
    `$disk = Mount-VHD -Path '${vhdxPath}' -Passthru | Get-Disk`,
    `Initialize-Disk -Number $disk.Number -PartitionStyle GPT`,
    `$part = New-Partition -DiskNumber $disk.Number -AssignDriveLetter -UseMaximumSize`,
    `Format-Volume -Partition $part -FileSystem NTFS -NewFileSystemLabel 'FClonediskBackup' -Confirm:$false`,
    `robocopy "${sourceLetter}:\\" "$($part.DriveLetter):\\" /MIR /XD "$RECYCLE.BIN" "System Volume Information" /R:1 /W:1`,
    `Dismount-VHD -Path '${vhdxPath}'`,
  ].join('; ');
}

/**
 * Locates TestDisk binary (including 06_OUTILS_SYSTEME\Testdisk from Handoff).
 */
function locateTestDisk(customPath) {
  const candidates = [
    customPath && typeof customPath === 'string' ? customPath : null,
    'C:\\06_OUTILS_SYSTEME\\Testdisk\\testdisk_win.exe',
    'D:\\06_OUTILS_SYSTEME\\Testdisk\\testdisk_win.exe',
    'C:\\Tools\\Testdisk\\testdisk_win.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Parses TestDisk log output lines into recoverable partition records.
 */
function parseTestDiskLog(logText, diskNumber = 0) {
  if (typeof logText !== 'string' || !logText.trim()) return [];
  const results = [];
  const lines = logText.split(/\r?\n/);
  // Example TestDisk line: " P NTFS                     0  32 33 15665  80 63  251658240 [Ancien_Studio]"
  const lineRe = /^\s*[*PDL]\s+(NTFS|FAT32|exFAT|EXT4|EXT3|EXT2|Linux|MS Data)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)(?:\s+\[([^\]]+)\])?/i;

  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const rawFs = m[1].toUpperCase();
    const fsType = rawFs === 'MS DATA' ? 'NTFS' : rawFs === 'LINUX' ? 'EXT4' : rawFs;
    const sectors = Number(m[2]);
    const sizeGB = Number(((sectors * 512) / 1024 ** 3).toFixed(2));
    if (sizeGB < 0.05) continue;
    const label = (m[3] || `Partition_${results.length + 1}`).trim();
    results.push({
      id: `td-${diskNumber}-${results.length + 1}`,
      diskNumber,
      label,
      fileSystem: fsType,
      sizeGB,
      usedGB: 0,
      filesCount: 0,
      integrity: 'Bonne',
    });
  }
  return results;
}

/**
 * Validates App Mover paths and generates a PowerShell script using robocopy + mklink /J
 * with automatic rollback if junction creation fails.
 */
function buildAppMoverScript(sourcePath, targetDrive) {
  const src = typeof sourcePath === 'string' ? sourcePath.trim().replace(/\\+$/, '') : '';
  if (!WINDOWS_SAFE_PATH_RE.test(src)) {
    throw new Error(`Chemin source invalide pour App Mover : "${sourcePath}".`);
  }
  for (const forbidden of PROTECTED_APP_PATHS) {
    if (forbidden.test(src)) {
      throw new Error(`Protection système : impossible de déplacer le dossier critique "${src}".`);
    }
  }
  const dstLetter = sanitizeLetter(targetDrive);
  const srcLetter = src[0].toUpperCase();
  if (dstLetter === srcLetter) {
    throw new Error('Le lecteur de destination doit être différent du lecteur source.');
  }

  const folderName = src.split('\\').pop();
  const dst = `${dstLetter}:\\FClonedisk_Apps\\${folderName}`;
  const backup = `${src}.fclonedisk_bak`;

  return [
    `$src = '${src}'`,
    `$dst = '${dst}'`,
    `$bak = '${backup}'`,
    `if (-not (Test-Path $src)) { throw "Dossier source introuvable : $src" }`,
    `New-Item -ItemType Directory -Force -Path $dst | Out-Null`,
    `robocopy $src $dst /E /COPYALL /R:2 /W:2`,
    `if ($LASTEXITCODE -ge 8) { throw "Échec robocopy (code $LASTEXITCODE) — aucune modification sur la source." }`,
    `Rename-Item -Path $src -NewName (Split-Path $bak -Leaf) -ErrorAction Stop`,
    `cmd /c mklink /J "$src" "$dst"`,
    `if ($LASTEXITCODE -ne 0) { Rename-Item -Path $bak -NewName (Split-Path $src -Leaf) -ErrorAction SilentlyContinue; throw "Échec mklink /J — rollback automatique effectué." }`,
    `Remove-Item -Path $bak -Recurse -Force -ErrorAction SilentlyContinue`,
  ].join('; ');
}

const GPT_TYPE_ESP = '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}';
const GPT_TYPE_BASIC_DATA = '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}';

/**
 * Builds the OS Migration plan: DiskWorker raw clone (with new disk GUID), then a PowerShell
 * script that finds the EFI and Windows partitions on the TARGET, gives them free letters,
 * rebuilds the boot files with bcdboot, and removes the temporary EFI letter.
 * GPT/UEFI only. Must run from WinPE (the source cannot be the running Windows).
 */
function buildMigrateOsCommands(sourceDiskNumber, targetDiskNumber) {
  const src = assertDiskNum(sourceDiskNumber, 'sourceDiskNumber');
  const dst = assertDiskNum(targetDiskNumber, 'targetDiskNumber');
  if (src === dst) throw new Error('Le disque cible de migration OS doit être différent du disque source.');
  const bcdScript = [
    `$n = ${dst}`,
    `if ((Get-Disk -Number $n).PartitionStyle -ne 'GPT') { throw "Migration réelle : disque GPT/UEFI uniquement." }`,
    `$parts = Get-Partition -DiskNumber $n`,
    `$esp = $parts | Where-Object { $_.GptType -eq '${GPT_TYPE_ESP}' } | Select-Object -First 1`,
    `if (-not $esp) { throw "Partition EFI introuvable sur le Disque $n." }`,
    `$win = $parts | Where-Object { $_.GptType -eq '${GPT_TYPE_BASIC_DATA}' } | Sort-Object Size -Descending | Select-Object -First 1`,
    `if (-not $win) { throw "Partition Windows introuvable sur le Disque $n." }`,
    `$used = @((Get-Volume).DriveLetter) + @((Get-PSDrive -PSProvider FileSystem).Name)`,
    `$free = @([char[]](70..90) | Where-Object { $used -notcontains $_ })`,
    `if ($free.Count -lt 2) { throw "Pas assez de lettres de lecteur libres pour la migration." }`,
    `$winL = "$($win.DriveLetter)".Trim(); if (-not $winL -or $winL -eq [char]0) { $winL = "$($free[-2])"; Set-Partition -DiskNumber $n -PartitionNumber $win.PartitionNumber -NewDriveLetter $winL }`,
    `if (-not (Test-Path "$($winL):\\Windows\\System32\\winload.efi")) { throw "Aucun Windows UEFI trouvé sur $($winL): (Disque $n)." }`,
    `$espL = "$($free[-1])"`,
    `Add-PartitionAccessPath -DiskNumber $n -PartitionNumber $esp.PartitionNumber -AccessPath "$($espL):\\"`,
    `try { bcdboot "$($winL):\\Windows" /s "$($espL):" /f UEFI; if ($LASTEXITCODE -ne 0) { throw "bcdboot a échoué (code $LASTEXITCODE)." } } ` +
      `finally { Remove-PartitionAccessPath -DiskNumber $n -PartitionNumber $esp.PartitionNumber -AccessPath "$($espL):\\" -ErrorAction SilentlyContinue }`,
  ].join('; ');
  return {
    workerArgs: buildWorkerArgs('clone', { sourceDiskNumber: src, targetDiskNumber: dst }),
    bcdCommand: bcdScript,
  };
}

module.exports = {
  locateDiskWorker,
  buildWorkerArgs,
  runDiskWorker,
  parseSmartctlJson,
  readSmartWithSmartctl,
  buildWinPeCommands,
  locateWindowsAdkWinPe,
  buildBackupCommand,
  locateTestDisk,
  parseTestDiskLog,
  buildAppMoverScript,
  buildMigrateOsCommands,
};
