import type { Disk, DiskIdentity, FileSystemType, Partition, PartitionRole, PendingOperation } from '../types/disk';

export function cloneDisks(disks: Disk[]): Disk[] {
  return JSON.parse(JSON.stringify(disks));
}

export function buildDiskIdentity(disk: Disk): DiskIdentity {
  return {
    diskNumber: disk.number,
    model: disk.model,
    serial: disk.serial,
    uniqueId: disk.uniqueId || '',
    sizeBytes: disk.sizeBytes ?? Math.round(disk.sizeGB * 1024 ** 3),
    sizeGB: disk.sizeGB,
  };
}

export function assertPartitionHasRealNumber(part: Partition): void {
  if (part.isPendingNew || part.partitionNumber <= 0) {
    throw new Error(
      "Cette partition vient d'être créée dans la file d'attente et n'a pas encore de PartitionNumber Windows. Appliquez d'abord la création puis actualisez les disques avant d'enchaîner une autre opération dessus."
    );
  }
}

export function getUsedLetters(disks: Disk[]): Set<string> {
  const used = new Set<string>();
  for (const d of disks) {
    for (const p of d.partitions) {
      if (p.letter) used.add(p.letter.toUpperCase());
    }
  }
  return used;
}

export function getAvailableLetters(disks: Disk[]): string[] {
  const used = getUsedLetters(disks);
  const all: string[] = [];
  for (let code = 67; code <= 90; code++) {
    const l = `${String.fromCharCode(code)}:`;
    if (!used.has(l)) all.push(l);
  }
  return all;
}

/**
 * Merges adjacent Unallocated blocks while STRICTLY preserving every real Windows partitionNumber.
 * NEVER renumbers partitions by array position.
 * Unallocated and newly queued (isPendingNew) partitions keep partitionNumber = 0.
 */
export function normalizePartitions(partitions: Partition[]): Partition[] {
  const merged: Partition[] = [];
  for (const p of partitions) {
    if (p.sizeGB <= 0.05) continue;
    const prev = merged[merged.length - 1];
    if (p.fileSystem === 'Unallocated' && prev && prev.fileSystem === 'Unallocated') {
      prev.sizeGB = Number((prev.sizeGB + p.sizeGB).toFixed(2));
    } else {
      merged.push({
        ...p,
        partitionNumber: p.fileSystem === 'Unallocated' || p.isPendingNew ? 0 : p.partitionNumber,
        sizeGB: Number(p.sizeGB.toFixed(2)),
        usedGB: Number(Math.min(p.usedGB, p.sizeGB).toFixed(2)),
      });
    }
  }
  return merged;
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function formatSize(gb: number): string {
  if (!Number.isFinite(gb) || gb < 0) return '0 Mo';
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} To`;
  if (gb < 1) return `${Math.round(gb * 1024)} Mo`;
  return `${gb.toFixed(1)} Go`;
}

export function diskHasSystemPartition(disk: Disk): boolean {
  return disk.partitions.some((p) => p.isSystem || p.role === 'System' || p.role === 'EFI');
}

export function createPartitionOp(
  disks: Disk[],
  diskId: string,
  unallocatedPartId: string,
  opts: {
    sizeGB: number;
    fileSystem: FileSystemType;
    letter: string;
    label: string;
    clusterSize: string;
    role: PartitionRole;
    aligned4K: boolean;
  }
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const disk = nextDisks.find((d) => d.id === diskId);
  if (!disk) throw new Error('Disque introuvable.');
  const idx = disk.partitions.findIndex((p) => p.id === unallocatedPartId);
  if (idx === -1) throw new Error('Espace non alloué introuvable.');

  const target = disk.partitions[idx];
  if (target.fileSystem !== 'Unallocated') {
    throw new Error('Impossible de créer une partition : la zone sélectionnée n’est pas un espace non alloué.');
  }

  const actualSize = Number(Math.min(Math.max(0.5, opts.sizeGB), target.sizeGB).toFixed(2));
  const remaining = Number((target.sizeGB - actualSize).toFixed(2));

  const newPart: Partition = {
    id: uid('part'),
    partitionNumber: 0,
    isPendingNew: true,
    letter: opts.fileSystem.startsWith('EXT') || opts.fileSystem === 'LinuxSwap' ? '' : opts.letter,
    label: opts.label || 'Nouveau volume',
    fileSystem: opts.fileSystem,
    sizeGB: actualSize,
    usedGB: Number((actualSize * 0.004).toFixed(2)),
    role: opts.role,
    aligned4K: opts.aligned4K,
    clusterSize: opts.clusterSize,
  };

  const replacement: Partition[] = [newPart];
  if (remaining > 0.1) {
    replacement.push({
      id: uid('unalloc'),
      partitionNumber: 0,
      letter: '',
      label: 'Non alloué',
      fileSystem: 'Unallocated',
      sizeGB: remaining,
      usedGB: 0,
      role: 'Unallocated',
      aligned4K: true,
      clusterSize: '-',
    });
  }

  disk.partitions.splice(idx, 1, ...replacement);
  disk.partitions = normalizePartitions(disk.partitions);

  const op: PendingOperation = {
    id: uid('op'),
    type: 'create',
    diskNumber: disk.number,
    diskIdentity: buildDiskIdentity(disk),
    title: `Créer partition ${newPart.letter || newPart.label} (${opts.fileSystem})`,
    description: `Créer une partition ${opts.fileSystem} de ${formatSize(actualSize)} sur Disque ${disk.number} (${newPart.label})`,
    commandPreview: `New-Partition -DiskNumber ${disk.number} -Size ${Math.round(actualSize * 1024)}MB ${newPart.letter ? `-DriveLetter ${newPart.letter.replace(':', '')}` : '-AssignDriveLetter'} | Format-Volume -FileSystem ${opts.fileSystem} -NewFileSystemLabel '${newPart.label}'`,
    params: { ...opts, sizeGB: actualSize },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}

export function resizePartitionOp(
  disks: Disk[],
  diskId: string,
  partId: string,
  newSizeGB: number
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const disk = nextDisks.find((d) => d.id === diskId);
  if (!disk) throw new Error('Disque introuvable.');
  const idx = disk.partitions.findIndex((p) => p.id === partId);
  if (idx === -1) throw new Error('Partition introuvable.');

  const part = disk.partitions[idx];
  if (part.fileSystem === 'Unallocated') throw new Error('Impossible de redimensionner un espace non alloué.');
  assertPartitionHasRealNumber(part);

  const realPartNum = part.partitionNumber;
  const oldSize = part.sizeGB;
  const minAllowed = Number(Math.max(part.usedGB + 0.5, 0.5).toFixed(2));
  const clampedTarget = Math.max(minAllowed, Number(newSizeGB.toFixed(2)));
  const delta = Number((clampedTarget - oldSize).toFixed(2));

  if (delta < 0) {
    part.sizeGB = clampedTarget;
    disk.partitions.splice(idx + 1, 0, {
      id: uid('unalloc'),
      partitionNumber: 0,
      letter: '',
      label: 'Non alloué',
      fileSystem: 'Unallocated',
      sizeGB: Math.abs(delta),
      usedGB: 0,
      role: 'Unallocated',
      aligned4K: true,
      clusterSize: '-',
    });
  } else if (delta > 0) {
    let needed = delta;
    const right = disk.partitions[idx + 1];
    if (right && right.fileSystem === 'Unallocated') {
      const take = Math.min(needed, right.sizeGB);
      right.sizeGB = Number((right.sizeGB - take).toFixed(2));
      needed = Number((needed - take).toFixed(2));
    }
    const left = disk.partitions[idx - 1];
    if (needed > 0 && left && left.fileSystem === 'Unallocated') {
      const take = Math.min(needed, left.sizeGB);
      left.sizeGB = Number((left.sizeGB - take).toFixed(2));
      needed = Number((needed - take).toFixed(2));
    }
    part.sizeGB = Number((oldSize + (delta - needed)).toFixed(2));
  }

  disk.partitions = normalizePartitions(disk.partitions);

  const op: PendingOperation = {
    id: uid('op'),
    type: 'resize',
    diskNumber: disk.number,
    diskIdentity: buildDiskIdentity(disk),
    partitionNumber: realPartNum,
    title: `Redimensionner ${part.letter || part.label}`,
    description: `${formatSize(oldSize)} → ${formatSize(part.sizeGB)} sur Disque ${disk.number}`,
    commandPreview: `Resize-Partition -DiskNumber ${disk.number} -PartitionNumber ${realPartNum} -Size ${Math.round(part.sizeGB * 1024)}MB`,
    params: { oldSizeGB: oldSize, newSizeGB: part.sizeGB },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}

export function formatPartitionOp(
  disks: Disk[],
  diskId: string,
  partId: string,
  opts: { fileSystem: FileSystemType; label: string; clusterSize: string; quick: boolean }
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const disk = nextDisks.find((d) => d.id === diskId);
  if (!disk) throw new Error('Disque introuvable.');
  const part = disk.partitions.find((p) => p.id === partId);
  if (!part) throw new Error('Partition introuvable.');
  if (part.isSystem) throw new Error('Protection système : impossible de formater la partition OS.');
  assertPartitionHasRealNumber(part);

  const origLetter = part.letter;
  part.fileSystem = opts.fileSystem;
  part.label = opts.label || part.label;
  part.clusterSize = opts.clusterSize;
  part.usedGB = Number((part.sizeGB * 0.003).toFixed(2));
  if (opts.fileSystem.startsWith('EXT') || opts.fileSystem === 'LinuxSwap') {
    part.letter = '';
  }

  const op: PendingOperation = {
    id: uid('op'),
    type: 'format',
    diskNumber: disk.number,
    diskIdentity: buildDiskIdentity(disk),
    partitionNumber: part.partitionNumber,
    title: `Formater ${origLetter || part.label} en ${opts.fileSystem}`,
    description: `Formatage ${opts.quick ? 'rapide' : 'complet'} (${opts.fileSystem}, cluster ${opts.clusterSize})`,
    commandPreview: `Format-Volume ${origLetter ? `-DriveLetter ${origLetter.replace(':', '')}` : ''} -FileSystem ${opts.fileSystem} -NewFileSystemLabel '${part.label}' -Confirm:$false`,
    params: { ...opts, letter: origLetter, sizeGB: part.sizeGB },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}

export function deletePartitionOp(
  disks: Disk[],
  diskId: string,
  partId: string,
  wipeMethod?: string
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const disk = nextDisks.find((d) => d.id === diskId);
  if (!disk) throw new Error('Disque introuvable.');
  const idx = disk.partitions.findIndex((p) => p.id === partId);
  if (idx === -1) throw new Error('Partition introuvable.');

  const part = disk.partitions[idx];
  if (part.isSystem) throw new Error('Protection système : impossible de supprimer une partition système.');
  assertPartitionHasRealNumber(part);

  const labelRef = part.letter || part.label;
  const origPartNum = part.partitionNumber;
  disk.partitions[idx] = {
    id: uid('unalloc'),
    partitionNumber: 0,
    letter: '',
    label: 'Non alloué',
    fileSystem: 'Unallocated',
    sizeGB: part.sizeGB,
    usedGB: 0,
    role: 'Unallocated',
    aligned4K: true,
    clusterSize: '-',
  };
  disk.partitions = normalizePartitions(disk.partitions);

  const op: PendingOperation = {
    id: uid('op'),
    type: wipeMethod ? 'wipe_partition' : 'delete',
    diskNumber: disk.number,
    diskIdentity: buildDiskIdentity(disk),
    partitionNumber: origPartNum,
    title: wipeMethod ? `Effacer définitivement ${labelRef}` : `Supprimer partition ${labelRef}`,
    description: wipeMethod
      ? `Effacement sécurisé (${wipeMethod}) de ${formatSize(part.sizeGB)} sur Disque ${disk.number}`
      : `Suppression de ${labelRef} (${formatSize(part.sizeGB)}) → espace non alloué`,
    commandPreview: wipeMethod
      ? `# F-Clonedisk Wipe (${wipeMethod}): Disk ${disk.number} Partition ${origPartNum}`
      : `Remove-Partition -DiskNumber ${disk.number} -PartitionNumber ${origPartNum} -Confirm:$false`,
    params: { wipeMethod, sizeGB: part.sizeGB },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}

export function splitPartitionOp(
  disks: Disk[],
  diskId: string,
  partId: string,
  newPartSizeGB: number,
  newLetter: string,
  newLabel: string
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const disk = nextDisks.find((d) => d.id === diskId);
  if (!disk) throw new Error('Disque introuvable.');
  const idx = disk.partitions.findIndex((p) => p.id === partId);
  if (idx === -1) throw new Error('Partition introuvable.');

  const part = disk.partitions[idx];
  assertPartitionHasRealNumber(part);

  const maxSplit = Number((part.sizeGB - Math.max(part.usedGB + 2, 1)).toFixed(2));
  if (maxSplit < 1) {
    throw new Error('Espace libre insuffisant pour diviser cette partition (minimum 1 Go libre requis).');
  }

  const splitSize = Number(Math.min(Math.max(1, newPartSizeGB), maxSplit).toFixed(2));
  part.sizeGB = Number((part.sizeGB - splitSize).toFixed(2));

  const created: Partition = {
    id: uid('part'),
    partitionNumber: 0,
    isPendingNew: true,
    letter: newLetter,
    label: newLabel || 'Partition divisée',
    fileSystem: part.fileSystem,
    sizeGB: splitSize,
    usedGB: Number((splitSize * 0.003).toFixed(2)),
    role: 'Primary',
    aligned4K: true,
    clusterSize: part.clusterSize,
  };
  disk.partitions.splice(idx + 1, 0, created);
  disk.partitions = normalizePartitions(disk.partitions);

  const op: PendingOperation = {
    id: uid('op'),
    type: 'split',
    diskNumber: disk.number,
    diskIdentity: buildDiskIdentity(disk),
    partitionNumber: part.partitionNumber,
    title: `Diviser ${part.letter || part.label} → ${newLetter || created.label}`,
    description: `Nouvelle partition de ${formatSize(splitSize)} créée depuis ${part.letter || part.label}`,
    commandPreview: `# F-Clonedisk Split: Disk ${disk.number} (-${splitSize}GB) -> ${newLetter || created.label}`,
    params: { splitSize, newLetter, newLabel },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}

export function mergePartitionsOp(
  disks: Disk[],
  diskId: string,
  targetPartId: string,
  sourcePartId: string
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const disk = nextDisks.find((d) => d.id === diskId);
  if (!disk) throw new Error('Disque introuvable.');
  const tIdx = disk.partitions.findIndex((p) => p.id === targetPartId);
  const sIdx = disk.partitions.findIndex((p) => p.id === sourcePartId);
  if (tIdx === -1 || sIdx === -1) throw new Error('Partitions introuvables.');

  const target = disk.partitions[tIdx];
  const source = disk.partitions[sIdx];
  assertPartitionHasRealNumber(target);
  if (source.fileSystem !== 'Unallocated') assertPartitionHasRealNumber(source);
  if (source.isSystem) throw new Error('Impossible de fusionner une partition système en tant que source.');
  const sourceName = source.letter || source.label;

  target.sizeGB = Number((target.sizeGB + source.sizeGB).toFixed(2));
  target.usedGB = Number((target.usedGB + source.usedGB).toFixed(2));
  disk.partitions.splice(sIdx, 1);
  disk.partitions = normalizePartitions(disk.partitions);

  const op: PendingOperation = {
    id: uid('op'),
    type: 'merge',
    diskNumber: disk.number,
    diskIdentity: buildDiskIdentity(disk),
    title: `Fusionner ${sourceName} dans ${target.letter || target.label}`,
    description: `Capacité totale résultante : ${formatSize(target.sizeGB)} sur Disque ${disk.number}`,
    commandPreview: `# F-Clonedisk Merge Engine: ${sourceName} -> ${target.letter || target.label}`,
    params: { target: target.letter, source: sourceName },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}

export function allocateFreeSpaceOp(
  disks: Disk[],
  diskId: string,
  fromPartId: string,
  toPartId: string,
  amountGB: number
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const disk = nextDisks.find((d) => d.id === diskId);
  if (!disk) throw new Error('Disque introuvable.');
  const from = disk.partitions.find((p) => p.id === fromPartId);
  const to = disk.partitions.find((p) => p.id === toPartId);
  if (!from || !to) throw new Error('Partition introuvable.');
  assertPartitionHasRealNumber(from);
  assertPartitionHasRealNumber(to);

  const maxFree = Math.max(0, from.sizeGB - from.usedGB - 1);
  const transfer = Number(Math.min(amountGB, maxFree).toFixed(2));
  if (transfer < 0.5) throw new Error('Espace libre insuffisant à transférer.');

  from.sizeGB = Number((from.sizeGB - transfer).toFixed(2));
  to.sizeGB = Number((to.sizeGB + transfer).toFixed(2));
  disk.partitions = normalizePartitions(disk.partitions);

  const op: PendingOperation = {
    id: uid('op'),
    type: 'allocate',
    diskNumber: disk.number,
    diskIdentity: buildDiskIdentity(disk),
    title: `Allouer ${formatSize(transfer)} : ${from.letter || from.label} → ${to.letter || to.label}`,
    description: `Transfert d'espace libre sans perte de données sur Disque ${disk.number}`,
    commandPreview: `# F-Clonedisk Allocate: Shrink ${from.letter} (-${transfer}GB) -> Extend ${to.letter} (+${transfer}GB)`,
    params: { from: from.letter, to: to.letter, transfer },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}

export function cloneDiskOp(
  disks: Disk[],
  sourceDiskId: string,
  targetDiskId: string,
  opts: { mode: 'quick' | 'sector'; align4K: boolean; fitMode: 'proportional' | 'original' }
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const source = nextDisks.find((d) => d.id === sourceDiskId);
  const target = nextDisks.find((d) => d.id === targetDiskId);
  if (!source || !target) throw new Error('Disque source ou cible introuvable.');
  if (source.id === target.id) throw new Error('Les disques source et cible doivent être différents.');
  if (diskHasSystemPartition(target)) {
    throw new Error(`Protection système : impossible d'écraser le Disque ${target.number} qui contient Windows.`);
  }

  const sourceNonUnalloc = source.partitions.filter((p) => p.fileSystem !== 'Unallocated');
  const totalUsed = sourceNonUnalloc.reduce((acc, p) => acc + p.usedGB, 0);
  if (opts.mode === 'sector' && target.sizeGB < source.sizeGB) {
    throw new Error(
      `Clone secteur par secteur impossible : la cible (${formatSize(target.sizeGB)}) est plus petite que la source (${formatSize(source.sizeGB)}).`
    );
  }
  if (target.sizeGB < totalUsed + 2) {
    throw new Error(
      `Espace insuffisant sur la cible (${formatSize(target.sizeGB)}) pour contenir les ${formatSize(totalUsed)} de données utilisées.`
    );
  }

  const fixedParts = sourceNonUnalloc.filter((p) => p.role === 'EFI' || p.role === 'Recovery');
  const flexParts = sourceNonUnalloc.filter((p) => p.role !== 'EFI' && p.role !== 'Recovery');
  const fixedTotal = fixedParts.reduce((a, p) => a + p.sizeGB, 0);
  const flexTotal = flexParts.reduce((a, p) => a + p.sizeGB, 0);
  const availableForFlex = Math.max(1, target.sizeGB - fixedTotal);
  const ratio = opts.fitMode === 'proportional' && flexTotal > 0 ? availableForFlex / flexTotal : 1;

  const usedLetters = getUsedLetters(nextDisks);
  let remainingTarget = target.sizeGB;
  const clonedParts: Partition[] = [];

  for (const sp of sourceNonUnalloc) {
    const isFixed = sp.role === 'EFI' || sp.role === 'Recovery';
    let newSize = isFixed ? sp.sizeGB : Number(Math.max(sp.usedGB + 0.5, sp.sizeGB * ratio).toFixed(2));
    newSize = Math.min(newSize, remainingTarget);
    if (newSize < 0.2) continue;
    remainingTarget = Number((remainingTarget - newSize).toFixed(2));

    let letter = '';
    if (sp.letter) {
      for (let code = 67; code <= 90; code++) {
        const candidate = `${String.fromCharCode(code)}:`;
        if (!usedLetters.has(candidate)) {
          letter = candidate;
          usedLetters.add(candidate);
          break;
        }
      }
    }

    clonedParts.push({
      ...sp,
      id: uid('clone'),
      partitionNumber: 0,
      isPendingNew: true,
      letter,
      label: sp.label.includes('(Clone)') ? sp.label : `${sp.label} (Clone)`,
      sizeGB: newSize,
      usedGB: Math.min(sp.usedGB, newSize),
      isSystem: false,
      aligned4K: opts.align4K ? true : sp.aligned4K,
    });
  }

  if (remainingTarget > 0.5) {
    clonedParts.push({
      id: uid('unalloc'),
      partitionNumber: 0,
      letter: '',
      label: 'Non alloué',
      fileSystem: 'Unallocated',
      sizeGB: remainingTarget,
      usedGB: 0,
      role: 'Unallocated',
      aligned4K: true,
      clusterSize: '-',
    });
  }

  target.partitionStyle = source.partitionStyle;
  target.partitions = normalizePartitions(clonedParts);

  const op: PendingOperation = {
    id: uid('op'),
    type: 'clone_disk',
    diskNumber: target.number,
    diskIdentity: buildDiskIdentity(target),
    title: `Cloner Disque ${source.number} → Disque ${target.number}`,
    description: `${opts.mode === 'quick' ? 'Clone rapide (secteurs utilisés)' : 'Clone secteur par secteur'}${opts.align4K ? ' + Alignement SSD 4K' : ''}`,
    commandPreview: `# F-Clonedisk Engine: CloneDisk --src=PhysicalDrive${source.number} --dst=PhysicalDrive${target.number} --mode=${opts.mode} --align4k=${opts.align4K}`,
    params: { sourceDiskNumber: source.number, targetDiskNumber: target.number, ...opts },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}

export function migrateOsOp(
  disks: Disk[],
  targetDiskId: string,
  align4K: boolean
): { nextDisks: Disk[]; op: PendingOperation } {
  const nextDisks = cloneDisks(disks);
  const source = nextDisks.find((d) => diskHasSystemPartition(d));
  const target = nextDisks.find((d) => d.id === targetDiskId);
  if (!source || !target) throw new Error('Disque système ou cible introuvable.');
  if (source.id === target.id) throw new Error('Impossible de migrer l’OS sur le même disque.');

  const osParts = source.partitions.filter((p) => p.isSystem || p.role === 'EFI' || p.role === 'Recovery');
  const minNeeded = osParts.reduce((s, p) => s + p.usedGB, 0) + 5;
  if (target.sizeGB < minNeeded) {
    throw new Error(`Disque cible trop petit (${formatSize(target.sizeGB)}). Minimum requis : ${formatSize(minNeeded)}.`);
  }

  const usedLetters = getUsedLetters(nextDisks);
  let remaining = target.sizeGB;
  const migrated: Partition[] = [];

  for (const sp of osParts) {
    const isMainOs = sp.role === 'System';
    const size = isMainOs
      ? Number(Math.max(sp.usedGB + 15, Math.min(sp.sizeGB, remaining - 2)).toFixed(2))
      : sp.sizeGB;
    const clamped = Math.min(size, remaining);
    remaining = Number((remaining - clamped).toFixed(2));

    let letter = '';
    if (isMainOs) {
      for (let code = 67; code <= 90; code++) {
        const c = `${String.fromCharCode(code)}:`;
        if (!usedLetters.has(c)) {
          letter = c;
          usedLetters.add(c);
          break;
        }
      }
    }

    migrated.push({
      ...sp,
      id: uid('os'),
      partitionNumber: 0,
      isPendingNew: true,
      letter,
      label: isMainOs ? `${sp.label} (Migré)` : sp.label,
      sizeGB: clamped,
      isSystem: false,
      aligned4K: align4K ? true : sp.aligned4K,
    });
  }

  if (remaining > 0.5) {
    migrated.push({
      id: uid('unalloc'),
      partitionNumber: 0,
      letter: '',
      label: 'Non alloué',
      fileSystem: 'Unallocated',
      sizeGB: remaining,
      usedGB: 0,
      role: 'Unallocated',
      aligned4K: true,
      clusterSize: '-',
    });
  }

  target.partitionStyle = 'GPT';
  target.partitions = normalizePartitions(migrated);

  const op: PendingOperation = {
    id: uid('op'),
    type: 'migrate_os',
    diskNumber: target.number,
    diskIdentity: buildDiskIdentity(target),
    title: `Migrer l'OS (Disque ${source.number}) → Disque ${target.number}`,
    description: `Migration EFI + Windows + WinRE vers ${target.model} avec réparation BCD UEFI`,
    commandPreview: `# F-Clonedisk OS Migrator: Disk ${source.number} -> Disk ${target.number} && bcdboot /f UEFI`,
    params: { sourceDiskNumber: source.number, targetDiskNumber: target.number, align4K },
    createdAt: new Date().toLocaleTimeString('fr-FR'),
  };

  return { nextDisks, op };
}
