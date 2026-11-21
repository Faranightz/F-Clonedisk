import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Disc,
  Eraser,
  EyeOff,
  FolderSync,
  Gauge,
  HardDrive,
  Info,
  Layers,
  Moon,
  PlusCircle,
  Redo2,
  RefreshCw,
  Scissors,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Sun,
  Tag,
  Trash2,
  Undo2,
  Wrench,
  XCircle,
} from 'lucide-react';
import type {
  ActiveModal,
  Disk,
  FileSystemType,
  Partition,
  PartitionRole,
  PendingOperation,
  RecoverablePartition,
  Selection,
} from './types/disk';
import { INITIAL_DISKS, MOCK_MOVABLE_APPS } from './data/mockDisks';
import {
  allocateFreeSpaceOp,
  cloneDiskOp,
  cloneDisks,
  createPartitionOp,
  deletePartitionOp,
  diskHasSystemPartition,
  formatPartitionOp,
  formatSize,
  getAvailableLetters,
  mergePartitionsOp,
  migrateOsOp,
  normalizePartitions,
  resizePartitionOp,
  splitPartitionOp,
  uid,
} from './utils/diskEngine';
import { Wizards } from './components/Wizards';

interface HistoryEntry {
  disks: Disk[];
  ops: PendingOperation[];
}

const FS_COLOR: Record<FileSystemType, string> = {
  NTFS: 'var(--fs-ntfs)',
  FAT32: 'var(--fs-fat32)',
  exFAT: 'var(--fs-exfat)',
  EXT4: 'var(--fs-ext4)',
  EXT3: '#84cc16',
  EXT2: '#a3e635',
  ReFS: 'var(--fs-refs)',
  LinuxSwap: 'var(--fs-swap)',
  RAW: 'var(--fs-raw)',
  Unallocated: 'var(--fs-unalloc)',
};

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [simulationMode, setSimulationMode] = useState<boolean>(true);
  const [disks, setDisks] = useState<Disk[]>(() => cloneDisks(INITIAL_DISKS));
  const [committedDisks, setCommittedDisks] = useState<Disk[]>(() => cloneDisks(INITIAL_DISKS));
  const [pendingOps, setPendingOps] = useState<PendingOperation[]>([]);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [selection, setSelection] = useState<Selection>({ diskId: 'disk-0', partitionId: 'p-0-2' });
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('keydown', onKey);
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3400);
  };

  const selectedDisk = useMemo(() => disks.find((d) => d.id === selection.diskId) || disks[0], [disks, selection.diskId]);
  const selectedPartition = useMemo(
    () => selectedDisk?.partitions.find((p) => p.id === selection.partitionId),
    [selectedDisk, selection.partitionId]
  );

  // Keep selection valid whenever disks change
  useEffect(() => {
    if (!selectedDisk && disks.length > 0) {
      setSelection({ diskId: disks[0].id, partitionId: disks[0].partitions[0]?.id });
    } else if (selectedDisk && selection.partitionId && !selectedPartition) {
      setSelection({ diskId: selectedDisk.id });
    }
  }, [disks, selectedDisk, selection.partitionId, selectedPartition]);

  const isUnallocated = selectedPartition?.fileSystem === 'Unallocated';
  const isRegularPart = Boolean(selectedPartition && !isUnallocated);
  const isSelectedDiskSystem = Boolean(selectedDisk && diskHasSystemPartition(selectedDisk));

  const pushState = (nextDisks: Disk[], op: PendingOperation) => {
    setUndoStack((prev) => [...prev, { disks: cloneDisks(disks), ops: [...pendingOps] }]);
    setRedoStack([]);
    setDisks(nextDisks);
    setPendingOps((prev) => [...prev, op]);
    showToast(`Planifié : ${op.title}`);
  };

  const runSafeOp = (fn: () => { nextDisks: Disk[]; op: PendingOperation }) => {
    try {
      const { nextDisks, op } = fn();
      pushState(nextDisks, op);
    } catch (err) {
      showToast((err as Error).message || 'Opération impossible.');
    }
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, { disks: cloneDisks(disks), ops: [...pendingOps] }]);
    setUndoStack((u) => u.slice(0, -1));
    setDisks(prev.disks);
    setPendingOps(prev.ops);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((u) => [...u, { disks: cloneDisks(disks), ops: [...pendingOps] }]);
    setRedoStack((r) => r.slice(0, -1));
    setDisks(next.disks);
    setPendingOps(next.ops);
  };

  const handleDiscard = () => {
    if (pendingOps.length === 0) return;
    setDisks(cloneDisks(committedDisks));
    setPendingOps([]);
    setUndoStack([]);
    setRedoStack([]);
    showToast('Toutes les opérations en attente ont été annulées.');
  };

  const loadRealWindowsDisks = async (): Promise<boolean> => {
    if (!window.fClonedisk?.isElectron || window.fClonedisk.platform !== 'win32') {
      showToast('Mode Windows Réel disponible dans l’exécutable Windows (.exe) en Administrateur.');
      return false;
    }
    const res = await window.fClonedisk.listDisks();
    if (!res.supported || !Array.isArray(res.disks)) {
      showToast(res.reason || 'Impossible de lire les disques Windows.');
      return false;
    }
    setDisks(cloneDisks(res.disks));
    setCommittedDisks(cloneDisks(res.disks));
    setPendingOps([]);
    setUndoStack([]);
    setRedoStack([]);
    if (res.disks.length > 0) {
      setSelection({ diskId: res.disks[0].id, partitionId: res.disks[0].partitions[0]?.id });
    }
    return true;
  };

  const handleToggleMode = async () => {
    if (simulationMode) {
      const ok = await loadRealWindowsDisks();
      if (ok) {
        setSimulationMode(false);
        showToast('Mode Windows Direct activé — disques physiques chargés.');
      }
    } else {
      const fresh = cloneDisks(INITIAL_DISKS);
      setSimulationMode(true);
      setDisks(fresh);
      setCommittedDisks(cloneDisks(fresh));
      setPendingOps([]);
      setUndoStack([]);
      setRedoStack([]);
      setSelection({ diskId: 'disk-0', partitionId: 'p-0-2' });
      showToast('Mode Simulation sécurisé activé.');
    }
  };

  const handleRefresh = async () => {
    if (!simulationMode) {
      const ok = await loadRealWindowsDisks();
      if (ok) showToast('Disques physiques Windows actualisés.');
    } else {
      showToast('Topologie simulée actualisée.');
    }
  };

  const handleOpenCreateAnything = () => {
    if (isUnallocated) {
      setActiveModal('create');
      return;
    }
    for (const d of disks) {
      const u = d.partitions.find((p) => p.fileSystem === 'Unallocated');
      if (u) {
        setSelection({ diskId: d.id, partitionId: u.id });
        setActiveModal('create');
        return;
      }
    }
    showToast('Aucun espace non alloué disponible. Réduisez ou supprimez d’abord une partition.');
  };

  const handleQuickAction = (
    action: 'convert_style' | 'align_4k' | 'convert_fs' | 'hide' | 'active' | 'check' | 'rebuild_mbr' | 'delete'
  ) => {
    if (!selectedDisk) return;
    const next = cloneDisks(disks);
    const d = next.find((x) => x.id === selectedDisk.id)!;
    const p = selectedPartition ? d.partitions.find((x) => x.id === selectedPartition.id) : undefined;

    if (action === 'convert_style') {
      const targetStyle = d.partitionStyle === 'GPT' ? 'MBR' : 'GPT';
      d.partitionStyle = targetStyle;
      pushState(next, {
        id: uid('op'),
        type: targetStyle === 'GPT' ? 'convert_gpt' : 'convert_mbr',
        diskNumber: d.number,
        title: `Convertir Disque ${d.number} en ${targetStyle}`,
        description: `Conversion sans perte de données vers table ${targetStyle}`,
        commandPreview:
          targetStyle === 'GPT' ? `mbr2gpt /convert /disk:${d.number} /allowFullOS` : `# F-Clonedisk: Convert-DiskToMBR -DiskNumber ${d.number}`,
        params: { targetStyle },
        createdAt: new Date().toLocaleTimeString('fr-FR'),
      });
    } else if (action === 'align_4k') {
      if (p) p.aligned4K = true;
      else d.partitions.forEach((x) => (x.aligned4K = true));
      pushState(next, {
        id: uid('op'),
        type: 'align_4k',
        diskNumber: d.number,
        partitionNumber: p?.partitionNumber,
        title: p ? `Alignement 4K sur ${p.letter || p.label}` : `Alignement 4K Disque ${d.number}`,
        description: 'Optimisation des secteurs sur frontière 4096 octets (SSD)',
        commandPreview: `# F-Clonedisk 4K Align: Disk ${d.number}${p ? ` Partition ${p.partitionNumber}` : ''}`,
        params: {},
        createdAt: new Date().toLocaleTimeString('fr-FR'),
      });
    } else if (action === 'convert_fs' && p) {
      const targetFs: FileSystemType = p.fileSystem === 'NTFS' ? 'FAT32' : 'NTFS';
      p.fileSystem = targetFs;
      pushState(next, {
        id: uid('op'),
        type: 'convert_fs',
        diskNumber: d.number,
        partitionNumber: p.partitionNumber,
        title: `Convertir ${p.letter || p.label} en ${targetFs}`,
        description: `Conversion système de fichiers sans formatage vers ${targetFs}`,
        commandPreview: targetFs === 'NTFS' ? `convert ${p.letter} /fs:ntfs` : `# F-Clonedisk NTFS-to-FAT32: ${p.letter}`,
        params: { targetFs },
        createdAt: new Date().toLocaleTimeString('fr-FR'),
      });
    } else if (action === 'hide' && p) {
      p.isHidden = !p.isHidden;
      pushState(next, {
        id: uid('op'),
        type: 'hide',
        diskNumber: d.number,
        partitionNumber: p.partitionNumber,
        title: `${p.isHidden ? 'Masquer' : 'Afficher'} ${p.letter || p.label}`,
        description: p.isHidden ? 'Partition masquée dans l’Explorateur Windows' : 'Partition rendue visible',
        commandPreview: `Set-Partition -DiskNumber ${d.number} -PartitionNumber ${p.partitionNumber} -IsHidden $${p.isHidden}`,
        params: { isHidden: p.isHidden },
        createdAt: new Date().toLocaleTimeString('fr-FR'),
      });
    } else if (action === 'active' && p) {
      d.partitions.forEach((x) => (x.isActive = false));
      p.isActive = true;
      pushState(next, {
        id: uid('op'),
        type: 'set_active',
        diskNumber: d.number,
        partitionNumber: p.partitionNumber,
        title: `Définir ${p.letter || p.label} Active`,
        description: `Marquer comme partition d'amorçage active sur Disque ${d.number}`,
        commandPreview: `Set-Partition -DiskNumber ${d.number} -PartitionNumber ${p.partitionNumber} -IsActive $true`,
        params: {},
        createdAt: new Date().toLocaleTimeString('fr-FR'),
      });
    } else if (action === 'check' && p) {
      if (!p.letter) {
        showToast('Impossible de lancer Repair-Volume : cette partition n’a pas de lettre de lecteur.');
        return;
      }
      pushState(next, {
        id: uid('op'),
        type: 'check_partition',
        diskNumber: d.number,
        partitionNumber: p.partitionNumber,
        title: `Vérifier & Réparer ${p.letter}`,
        description: 'Vérification du système de fichiers (Repair-Volume -Scan)',
        commandPreview: `Repair-Volume -DriveLetter ${p.letter.replace(':', '')} -Scan`,
        params: { letter: p.letter },
        createdAt: new Date().toLocaleTimeString('fr-FR'),
      });
    } else if (action === 'rebuild_mbr') {
      pushState(next, {
        id: uid('op'),
        type: 'rebuild_mbr',
        diskNumber: d.number,
        title: `Reconstruire le MBR (Disque ${d.number})`,
        description: 'Réécriture du secteur d’amorçage principal Windows 10/11',
        commandPreview: `bootrec /fixmbr && bootrec /fixboot # Disk ${d.number}`,
        params: {},
        createdAt: new Date().toLocaleTimeString('fr-FR'),
      });
    } else if (action === 'delete' && p) {
      runSafeOp(() => deletePartitionOp(disks, d.id, p.id));
    }
  };

  const allRows = useMemo(() => {
    const rows: Array<{ disk: Disk; part: Partition }> = [];
    for (const disk of disks) {
      for (const part of disk.partitions) {
        rows.push({ disk, part });
      }
    }
    return rows;
  }, [disks]);

  const openContextMenu = (e: React.MouseEvent, diskId: string, partitionId?: string) => {
    e.preventDefault();
    setSelection({ diskId, partitionId });
    setContextMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 250)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 360)),
    });
  };

  return (
    <div className="app-shell">
      {/* Top Ribbon Toolbar */}
      <header className="top-bar">
        <div className="brand-group">
          <img src="./icon.png" alt="F-Clonedisk" className="brand-logo" />
          <div>
            <h1 className="brand-title">
              F-Clonedisk
              <span className="spec-chip ok" style={{ fontSize: 10.5 }}>PRO v1.0</span>
            </h1>
            <div className="brand-sub">Gestionnaire de Partitions, Clonage & Create Anything</div>
          </div>
        </div>

        <div className="ribbon-actions">
          <button
            className="btn btn-success"
            disabled={pendingOps.length === 0}
            onClick={() => setActiveModal('apply')}
            title="Appliquer toutes les opérations planifiées"
          >
            <Check size={15} />
            Appliquer
            {pendingOps.length > 0 && <span className="badge-count">{pendingOps.length}</span>}
          </button>

          <button className="btn" disabled={undoStack.length === 0} onClick={handleUndo} title="Annuler la dernière opération">
            <Undo2 size={14} /> Annuler
          </button>
          <button className="btn" disabled={redoStack.length === 0} onClick={handleRedo} aria-label="Rétablir" title="Rétablir">
            <Redo2 size={14} />
          </button>
          <button className="btn" disabled={pendingOps.length === 0} onClick={handleDiscard} title="Ignorer toutes les opérations en attente">
            <XCircle size={14} /> Ignorer
          </button>

          <div className="ribbon-divider" />

          <button className="btn btn-primary" onClick={() => setActiveModal('clone_disk')}>
            <Copy size={14} /> Cloner un disque
          </button>
          <button className="btn" onClick={() => setActiveModal('migrate_os')}>
            <Cpu size={14} /> Migrer l'OS
          </button>
          <button className="btn" onClick={handleOpenCreateAnything}>
            <PlusCircle size={14} color="var(--accent)" /> Create Anything
          </button>
          <button className="btn" onClick={() => setActiveModal('smart_bench')}>
            <Gauge size={14} /> S.M.A.R.T. & Bench
          </button>

          <div className="ribbon-divider" />

          <button className={`mode-pill ${simulationMode ? 'sim' : 'real'}`} onClick={handleToggleMode}>
            {simulationMode ? <ShieldCheck size={13} /> : <HardDrive size={13} />}
            {simulationMode ? 'Simulation' : 'Windows Réel'}
          </button>

          <button
            className="btn"
            aria-label="Changer le thème"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title="Changer le thème"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button className="btn" aria-label="Actualiser les disques" onClick={handleRefresh} title="Actualiser">
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* Workspace Body */}
      <div className="workspace-body">
        {/* Left Action & Wizards Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <span>
                {isUnallocated
                  ? 'Espace non alloué'
                  : isRegularPart
                    ? `Partition ${selectedPartition?.letter || selectedPartition?.label}`
                    : `Disque ${selectedDisk?.number ?? 0}`}
              </span>
              <span className="mono">{formatSize(selectedPartition ? selectedPartition.sizeGB : selectedDisk?.sizeGB || 0)}</span>
            </div>

            <div className="sidebar-list">
              {isUnallocated ? (
                <>
                  <button className="sidebar-item" onClick={() => setActiveModal('create')}>
                    <PlusCircle size={15} color="var(--accent)" /> Créer une partition (Create Anything)
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('recovery')}>
                    <Search size={15} /> Récupérer une partition perdue
                  </button>
                  <button className="sidebar-item" disabled={isSelectedDiskSystem} onClick={() => setActiveModal('wipe')}>
                    <ShieldAlert size={15} color="var(--danger)" /> Effacer l'espace non alloué
                  </button>
                </>
              ) : isRegularPart ? (
                <>
                  <button className="sidebar-item" onClick={() => setActiveModal('resize')}>
                    <Sliders size={15} color="var(--accent)" /> Redimensionner / Déplacer
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('merge')}>
                    <Layers size={15} /> Fusionner les partitions
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('split')}>
                    <Scissors size={15} /> Diviser la partition
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('allocate')}>
                    <Sparkles size={15} /> Allouer de l'espace libre
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('format')} disabled={selectedPartition?.isSystem}>
                    <Eraser size={15} /> Formater la partition
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('letter')} disabled={selectedPartition?.isSystem}>
                    <Tag size={15} /> Changer la lettre de lecteur
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('label')}>
                    <Tag size={15} /> Changer le nom (Label)
                  </button>
                  <button className="sidebar-item" onClick={() => handleQuickAction('convert_fs')} disabled={selectedPartition?.isSystem}>
                    <ArrowLeftRight size={15} /> Convertir {selectedPartition?.fileSystem === 'NTFS' ? 'NTFS → FAT32' : 'vers NTFS'}
                  </button>
                  <button className="sidebar-item" onClick={() => handleQuickAction('align_4k')}>
                    <CheckCircle2 size={15} color="var(--success)" /> Alignement SSD 4K
                  </button>
                  <button className="sidebar-item" onClick={() => handleQuickAction('check')}>
                    <Wrench size={15} /> Vérifier la partition (chkdsk)
                  </button>
                  <button className="sidebar-item" onClick={() => handleQuickAction('hide')} disabled={selectedPartition?.isSystem}>
                    <EyeOff size={15} /> {selectedPartition?.isHidden ? 'Afficher la partition' : 'Masquer la partition'}
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('properties')}>
                    <Info size={15} /> Propriétés
                  </button>
                  <button className="sidebar-item danger" onClick={() => handleQuickAction('delete')} disabled={selectedPartition?.isSystem}>
                    <Trash2 size={15} /> Supprimer la partition
                  </button>
                  <button className="sidebar-item danger" onClick={() => setActiveModal('wipe')} disabled={selectedPartition?.isSystem}>
                    <ShieldAlert size={15} /> Effacer définitivement (Wipe)
                  </button>
                </>
              ) : (
                <>
                  <button className="sidebar-item" onClick={() => setActiveModal('clone_disk')}>
                    <Copy size={15} color="var(--accent)" /> Cloner ce disque
                  </button>
                  <button className="sidebar-item" onClick={() => handleQuickAction('convert_style')}>
                    <ArrowLeftRight size={15} /> Convertir en {selectedDisk?.partitionStyle === 'GPT' ? 'MBR' : 'GPT'}
                  </button>
                  <button className="sidebar-item" onClick={() => handleQuickAction('rebuild_mbr')}>
                    <Wrench size={15} /> Reconstruire le MBR
                  </button>
                  <button className="sidebar-item" onClick={() => handleQuickAction('align_4k')}>
                    <CheckCircle2 size={15} color="var(--success)" /> Alignement 4K du disque
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('surface_test')}>
                    <Activity size={15} /> Test de surface (Secteurs)
                  </button>
                  <button className="sidebar-item" onClick={() => setActiveModal('smart_bench')}>
                    <Gauge size={15} /> Santé S.M.A.R.T. & Benchmark
                  </button>
                  <button className="sidebar-item danger" disabled={isSelectedDiskSystem} onClick={() => setActiveModal('wipe')}>
                    <ShieldAlert size={15} /> Effacer le disque (Wipe)
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <span>Assistants & Outils</span>
            </div>
            <div className="sidebar-list">
              <button className="sidebar-item" onClick={() => setActiveModal('clone_disk')}>
                <Copy size={15} color="var(--accent)" /> Assistant Clonage de Disque
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('migrate_os')}>
                <Cpu size={15} color="var(--accent)" /> Migrer l'OS vers SSD/HDD
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('recovery')}>
                <Search size={15} /> Récupération de Partitions
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('bootable_media')}>
                <Disc size={15} /> Créer un média bootable WinPE
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('app_mover')}>
                <FolderSync size={15} /> App Mover (Déplacer logiciels)
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('surface_test')}>
                <Activity size={15} /> Test de surface
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('smart_bench')}>
                <Gauge size={15} /> S.M.A.R.T. & Benchmark SSD
              </button>
              <button className="sidebar-item danger" onClick={() => setActiveModal('wipe')}>
                <ShieldAlert size={15} /> SSD Secure Erase / Wipe DoD
              </button>
            </div>
          </div>
        </aside>

        {/* Main Right Panel */}
        <main className="center-panel">
          <section className="table-container">
            <table className="part-table">
              <thead>
                <tr>
                  <th>Partition</th>
                  <th>Disque</th>
                  <th>Système</th>
                  <th>Capacité</th>
                  <th>Utilisé</th>
                  <th>Libre</th>
                  <th>Occupation</th>
                  <th>Rôle</th>
                  <th>4K</th>
                </tr>
              </thead>
              <tbody>
                {allRows.map(({ disk, part }) => {
                  const pct = part.sizeGB > 0 ? Math.round((part.usedGB / part.sizeGB) * 100) : 0;
                  const isSelected = selection.diskId === disk.id && selection.partitionId === part.id;
                  const freeGB = Math.max(0, part.sizeGB - part.usedGB);
                  return (
                    <tr
                      key={part.id}
                      tabIndex={0}
                      className={isSelected ? 'selected' : ''}
                      onClick={() => setSelection({ diskId: disk.id, partitionId: part.id })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelection({ diskId: disk.id, partitionId: part.id });
                        }
                      }}
                      onContextMenu={(e) => openContextMenu(e, disk.id, part.id)}
                    >
                      <td>
                        <strong>{part.letter || '—'}</strong> {part.label}
                        {part.isHidden && <span className="spec-chip" style={{ marginLeft: 6 }}>Masqué</span>}
                      </td>
                      <td className="mono" style={{ color: 'var(--text-muted)' }}>Disque {disk.number}</td>
                      <td>
                        <span className="fs-tag">
                          <span className="fs-dot" style={{ background: FS_COLOR[part.fileSystem] }} />
                          {part.fileSystem === 'Unallocated' ? 'Non alloué' : part.fileSystem}
                        </span>
                      </td>
                      <td className="mono">{formatSize(part.sizeGB)}</td>
                      <td className="mono">{part.fileSystem === 'Unallocated' ? '—' : formatSize(part.usedGB)}</td>
                      <td className="mono">{formatSize(freeGB)}</td>
                      <td>
                        {part.fileSystem === 'Unallocated' ? (
                          <span style={{ color: 'var(--text-muted)' }}>Disponible</span>
                        ) : (
                          <>
                            <span className="usage-bar">
                              <span
                                className="usage-bar-fill"
                                style={{
                                  width: `${pct}%`,
                                  background: pct > 85 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : FS_COLOR[part.fileSystem],
                                }}
                              />
                            </span>
                            <span className="mono" style={{ fontSize: 11.5 }}>{pct}%</span>
                          </>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-secondary)' }}>{part.role}</td>
                      <td>
                        {part.fileSystem === 'Unallocated' ? '—' : part.aligned4K ? (
                          <span style={{ color: 'var(--success)', fontWeight: 600 }}>4K OK</span>
                        ) : (
                          <span style={{ color: 'var(--warning)', fontWeight: 600 }}>Non aligné</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="disk-map-container">
            {disks.map((disk) => {
              const isDiskSelected = selection.diskId === disk.id && !selection.partitionId;
              const tempLabel = disk.smart.temperatureC !== null ? `${disk.smart.temperatureC}°C` : 'N/A';
              return (
                <div key={disk.id} className={`disk-card ${selection.diskId === disk.id ? 'selected' : ''}`}>
                  <div
                    className="disk-meta"
                    tabIndex={0}
                    style={{ background: isDiskSelected ? 'var(--accent-soft)' : undefined }}
                    onClick={() => setSelection({ diskId: disk.id })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelection({ diskId: disk.id });
                      }
                    }}
                    onContextMenu={(e) => openContextMenu(e, disk.id)}
                  >
                    <div className="disk-meta-top">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <HardDrive size={15} color="var(--accent)" /> Disque {disk.number}
                      </span>
                      <span className="mono" style={{ fontSize: 12 }}>{formatSize(disk.sizeGB)}</span>
                    </div>
                    <div className="disk-model" title={disk.model}>{disk.model}</div>
                    <div className="disk-specs">
                      <span className="spec-chip">{disk.partitionStyle}</span>
                      <span className="spec-chip">{disk.busType} {disk.mediaType}</span>
                      <span className={`spec-chip ${disk.health === 'Sain' ? 'ok' : 'warn'}`}>
                        {disk.smart.healthPercent}% • {tempLabel}
                      </span>
                    </div>
                  </div>

                  <div className="disk-partitions-strip">
                    {disk.partitions.map((part) => {
                      const pct = part.sizeGB > 0 ? Math.round((part.usedGB / part.sizeGB) * 100) : 0;
                      const flexWeight = Math.max(8, Math.round((part.sizeGB / Math.max(1, disk.sizeGB)) * 100));
                      const isPartSel = selection.diskId === disk.id && selection.partitionId === part.id;
                      const isUnalloc = part.fileSystem === 'Unallocated';
                      return (
                        <div
                          key={part.id}
                          tabIndex={0}
                          className={`part-block ${isPartSel ? 'selected' : ''} ${isUnalloc ? 'unalloc' : ''}`}
                          style={{ flex: `${flexWeight} 1 0%` }}
                          onClick={() => setSelection({ diskId: disk.id, partitionId: part.id })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelection({ diskId: disk.id, partitionId: part.id });
                            }
                          }}
                          onContextMenu={(e) => openContextMenu(e, disk.id, part.id)}
                        >
                          <div className="part-top-bar" style={{ background: FS_COLOR[part.fileSystem] }} />
                          <div className="part-title">
                            {part.letter ? `${part.letter} ` : ''}{part.label}
                          </div>
                          <div className="part-sub">
                            <span>{isUnalloc ? 'Non alloué' : part.fileSystem}</span>
                            <span className="mono">{formatSize(part.sizeGB)}</span>
                          </div>
                          {!isUnalloc && (
                            <div className="part-used-fill">
                              <div
                                style={{
                                  width: `${pct}%`,
                                  background: pct > 85 ? 'var(--danger)' : FS_COLOR[part.fileSystem],
                                }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </section>
        </main>
      </div>

      {/* Bottom Queue Drawer */}
      <footer className="queue-drawer">
        <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', color: pendingOps.length > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
          File d'attente ({pendingOps.length}) :
        </div>
        <div className="queue-chips">
          {pendingOps.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Aucune opération en attente. Clic droit sur une partition ou un disque pour commencer.
            </span>
          ) : (
            pendingOps.map((op, i) => (
              <span key={op.id} className="queue-chip" title={op.commandPreview}>
                <strong className="mono" style={{ color: 'var(--accent)' }}>#{i + 1}</strong> {op.title}
              </span>
            ))
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {disks.length} disques • {allRows.length} volumes
        </div>
      </footer>

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {isUnallocated ? (
            <>
              <button className="sidebar-item" onClick={() => setActiveModal('create')}>
                <PlusCircle size={14} color="var(--accent)" /> Créer une partition (Create Anything)
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('recovery')}>
                <Search size={14} /> Récupérer partition perdue
              </button>
            </>
          ) : isRegularPart ? (
            <>
              <button className="sidebar-item" onClick={() => setActiveModal('resize')}>
                <Sliders size={14} color="var(--accent)" /> Redimensionner / Déplacer
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('merge')}>
                <Layers size={14} /> Fusionner
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('split')}>
                <Scissors size={14} /> Diviser
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('allocate')}>
                <Sparkles size={14} /> Allouer espace libre
              </button>
              <div className="context-menu-sep" />
              <button className="sidebar-item" onClick={() => setActiveModal('format')} disabled={selectedPartition?.isSystem}>
                <Eraser size={14} /> Formater
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('letter')} disabled={selectedPartition?.isSystem}>
                <Tag size={14} /> Changer lettre
              </button>
              <button className="sidebar-item" onClick={() => handleQuickAction('align_4k')}>
                <CheckCircle2 size={14} color="var(--success)" /> Alignement 4K
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('properties')}>
                <Info size={14} /> Propriétés
              </button>
              <div className="context-menu-sep" />
              <button className="sidebar-item danger" onClick={() => handleQuickAction('delete')} disabled={selectedPartition?.isSystem}>
                <Trash2 size={14} /> Supprimer
              </button>
            </>
          ) : (
            <>
              <button className="sidebar-item" onClick={() => setActiveModal('clone_disk')}>
                <Copy size={14} color="var(--accent)" /> Cloner ce disque
              </button>
              <button className="sidebar-item" onClick={() => handleQuickAction('convert_style')}>
                <ArrowLeftRight size={14} /> Convertir GPT ↔ MBR
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('surface_test')}>
                <Activity size={14} /> Test de surface
              </button>
              <button className="sidebar-item" onClick={() => setActiveModal('smart_bench')}>
                <Gauge size={14} /> S.M.A.R.T. & Benchmark
              </button>
              <div className="context-menu-sep" />
              <button className="sidebar-item danger" disabled={isSelectedDiskSystem} onClick={() => setActiveModal('wipe')}>
                <ShieldAlert size={14} /> Effacer le disque
              </button>
            </>
          )}
        </div>
      )}

      {/* Conditionally mounted Wizards (guaranteed Rules of Hooks + fresh state on open) */}
      {activeModal && (
        <Wizards
          key={`${activeModal}-${selection.diskId}-${selection.partitionId ?? 'disk'}`}
          modal={activeModal}
          onClose={() => setActiveModal(null)}
          disks={disks}
          selectedDisk={selectedDisk}
          selectedPartition={selectedPartition}
          pendingOps={pendingOps}
          simulationMode={simulationMode}
          onCreatePartition={(opts: {
            sizeGB: number;
            fileSystem: FileSystemType;
            letter: string;
            label: string;
            clusterSize: string;
            role: PartitionRole;
            aligned4K: boolean;
          }) => {
            if (!selectedDisk || !selectedPartition) return;
            runSafeOp(() => createPartitionOp(disks, selectedDisk.id, selectedPartition.id, opts));
          }}
          onResizePartition={(newSizeGB) => {
            if (!selectedDisk || !selectedPartition) return;
            runSafeOp(() => resizePartitionOp(disks, selectedDisk.id, selectedPartition.id, newSizeGB));
          }}
          onFormatPartition={(opts) => {
            if (!selectedDisk || !selectedPartition) return;
            runSafeOp(() => formatPartitionOp(disks, selectedDisk.id, selectedPartition.id, opts));
          }}
          onSplitPartition={(newSizeGB, letter, label) => {
            if (!selectedDisk || !selectedPartition) return;
            runSafeOp(() => splitPartitionOp(disks, selectedDisk.id, selectedPartition.id, newSizeGB, letter, label));
          }}
          onMergePartition={(sourcePartId) => {
            if (!selectedDisk || !selectedPartition) return;
            runSafeOp(() => mergePartitionsOp(disks, selectedDisk.id, selectedPartition.id, sourcePartId));
          }}
          onAllocateSpace={(toPartId, amountGB) => {
            if (!selectedDisk || !selectedPartition) return;
            runSafeOp(() => allocateFreeSpaceOp(disks, selectedDisk.id, selectedPartition.id, toPartId, amountGB));
          }}
          onChangeLetter={(newLetter) => {
            if (!selectedDisk || !selectedPartition) return;
            const next = cloneDisks(disks);
            const d = next.find((x) => x.id === selectedDisk.id)!;
            const p = d.partitions.find((x) => x.id === selectedPartition.id)!;
            const oldLetter = p.letter;
            p.letter = newLetter;
            pushState(next, {
              id: uid('op'),
              type: 'letter',
              diskNumber: d.number,
              partitionNumber: p.partitionNumber,
              title: `Changer lettre → ${newLetter || '(Aucune)'}`,
              description: `Modification de la lettre de lecteur pour ${p.label}`,
              commandPreview: newLetter
                ? `Set-Partition -DiskNumber ${d.number} -PartitionNumber ${p.partitionNumber} -NewDriveLetter ${newLetter.replace(':', '')}`
                : `Remove-PartitionAccessPath -DiskNumber ${d.number} -PartitionNumber ${p.partitionNumber} -AccessPath '${oldLetter}\\'`,
              params: { newLetter, oldLetter },
              createdAt: new Date().toLocaleTimeString('fr-FR'),
            });
          }}
          onChangeLabel={(newLabel) => {
            if (!selectedDisk || !selectedPartition) return;
            if (!selectedPartition.letter && !simulationMode) {
              showToast('Impossible de renommer sous Windows natif sans lettre de lecteur.');
              return;
            }
            const next = cloneDisks(disks);
            const d = next.find((x) => x.id === selectedDisk.id)!;
            const p = d.partitions.find((x) => x.id === selectedPartition.id)!;
            p.label = newLabel;
            pushState(next, {
              id: uid('op'),
              type: 'label',
              diskNumber: d.number,
              partitionNumber: p.partitionNumber,
              title: `Renommer ${p.letter || 'volume'} → "${newLabel}"`,
              description: `Nouveau nom de volume sur Disque ${d.number}`,
              commandPreview: `Set-Volume -DriveLetter ${(p.letter || 'C').replace(':', '')} -NewFileSystemLabel '${newLabel.replace(/'/g, "''")}'`,
              params: { newLabel, letter: p.letter },
              createdAt: new Date().toLocaleTimeString('fr-FR'),
            });
          }}
          onWipe={(target, method) => {
            if (!selectedDisk) return;
            if (target === 'partition' && selectedPartition) {
              runSafeOp(() => deletePartitionOp(disks, selectedDisk.id, selectedPartition.id, method));
            } else {
              if (diskHasSystemPartition(selectedDisk)) {
                showToast('Protection système : impossible d’effacer le disque contenant Windows.');
                return;
              }
              const next = cloneDisks(disks);
              const d = next.find((x) => x.id === selectedDisk.id)!;
              d.partitions = [
                {
                  id: uid('unalloc'),
                  partitionNumber: 0,
                  letter: '',
                  label: 'Non alloué',
                  fileSystem: 'Unallocated',
                  sizeGB: d.sizeGB,
                  usedGB: 0,
                  role: 'Unallocated',
                  aligned4K: true,
                  clusterSize: '-',
                },
              ];
              pushState(next, {
                id: uid('op'),
                type: 'wipe_disk',
                diskNumber: d.number,
                title: `Effacer Disque ${d.number} (${method.split(' ')[0]})`,
                description: `Effacement complet de ${d.model} avec ${method}`,
                commandPreview: `Clear-Disk -Number ${d.number} -RemoveData -RemoveOEM -Confirm:$false`,
                params: { method },
                createdAt: new Date().toLocaleTimeString('fr-FR'),
              });
            }
          }}
          onCloneDisk={(sourceId, targetId, opts) => {
            runSafeOp(() => cloneDiskOp(disks, sourceId, targetId, opts));
          }}
          onMigrateOs={(targetDiskId, align4K) => {
            runSafeOp(() => migrateOsOp(disks, targetDiskId, align4K));
          }}
          onRecoverPartition={(rec: RecoverablePartition) => {
            const next = cloneDisks(disks);
            const d = next.find((x) => x.number === rec.diskNumber);
            if (!d) return;
            const unallocIdx = d.partitions.findIndex((p) => p.fileSystem === 'Unallocated' && p.sizeGB >= rec.sizeGB * 0.5);
            const letter = getAvailableLetters(next)[0] || 'R:';
            if (unallocIdx !== -1) {
              const u = d.partitions[unallocIdx];
              const restoredSize = Math.min(rec.sizeGB, u.sizeGB);
              const rem = Number((u.sizeGB - restoredSize).toFixed(2));
              const restored: Partition = {
                id: uid('rec'),
                partitionNumber: 0,
                letter,
                label: rec.label,
                fileSystem: rec.fileSystem,
                sizeGB: restoredSize,
                usedGB: Math.min(rec.usedGB, restoredSize),
                role: 'Primary',
                aligned4K: true,
                clusterSize: '4 Ko',
              };
              const list: Partition[] = [restored];
              if (rem > 0.5) list.push({ ...u, id: uid('unalloc'), sizeGB: rem });
              d.partitions.splice(unallocIdx, 1, ...list);
              d.partitions = normalizePartitions(d.partitions);
            }
            pushState(next, {
              id: uid('op'),
              type: 'recover_partition',
              diskNumber: rec.diskNumber,
              title: `Restaurer partition "${rec.label}" (${letter})`,
              description: `${rec.filesCount.toLocaleString('fr-FR')} fichiers restaurés sur Disque ${rec.diskNumber}`,
              commandPreview: `# F-Clonedisk Recovery: RestorePartition --disk=${rec.diskNumber} --label="${rec.label}" --letter=${letter}`,
              params: { ...rec },
              createdAt: new Date().toLocaleTimeString('fr-FR'),
            });
          }}
          onMoveApps={(appIds, targetDrive) => {
            const moved = MOCK_MOVABLE_APPS.filter((a) => appIds.includes(a.id));
            const totalGB = Number(moved.reduce((s, a) => s + a.sizeGB, 0).toFixed(1));
            const next = cloneDisks(disks);
            for (const d of next) {
              for (const p of d.partitions) {
                if (p.letter === 'C:') p.usedGB = Math.max(20, Number((p.usedGB - totalGB).toFixed(1)));
                if (p.letter === targetDrive) p.usedGB = Math.min(p.sizeGB - 1, Number((p.usedGB + totalGB).toFixed(1)));
              }
            }
            pushState(next, {
              id: uid('op'),
              type: 'app_mover',
              diskNumber: 0,
              title: `Déplacer ${moved.length} app(s) C: → ${targetDrive}`,
              description: `${formatSize(totalGB)} libérés sur C: avec jonctions NTFS`,
              commandPreview: `robocopy "C:\\Program Files\\..." "${targetDrive}\\Apps\\..." /MIR && mklink /J ...`,
              params: { appIds, targetDrive, totalGB },
              createdAt: new Date().toLocaleTimeString('fr-FR'),
            });
          }}
          onApplyFinished={async (allSucceeded) => {
            if (!allSucceeded) {
              if (!simulationMode) await loadRealWindowsDisks();
              showToast('Certaines opérations ont échoué — vérifiez le journal.');
              return;
            }
            if (!simulationMode) {
              await loadRealWindowsDisks();
            } else {
              setCommittedDisks(cloneDisks(disks));
              setPendingOps([]);
              setUndoStack([]);
              setRedoStack([]);
            }
            showToast('Opérations appliquées et table des partitions synchronisée !');
          }}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={15} color="var(--accent)" /> {toast}
        </div>
      )}
    </div>
  );
}
